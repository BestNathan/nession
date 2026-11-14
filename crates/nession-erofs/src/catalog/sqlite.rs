//! SQLite schema and statement helpers for the image catalog (#3496).
//!
//! The catalog does not open a database. Every function takes a
//! [`ConnectionTrait`] supplied by the Server, so schema, statements and data
//! migration run inside the Server's existing SQLite connection and
//! transaction authority. The Server is expected to use one SQLite connection
//! (the same single-owner SQLite policy the database already uses), which
//! serializes catalog writers with the rest of the Server.

use anyhow::{Context, Result};
use sea_orm::{ConnectionTrait, DbBackend, QueryResult, Statement, TransactionTrait, Value};

/// The catalog schema version this implementation owns.
pub const CATALOG_SCHEMA_VERSION: i64 = 1;

const SCHEMA_DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS catalog_schema (version INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS catalog_repositories (
        name TEXT NOT NULL PRIMARY KEY,
        created_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS catalog_tags (
        repository TEXT NOT NULL,
        tag TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repository, tag)
    )",
    "CREATE INDEX IF NOT EXISTS idx_catalog_tags_digest
        ON catalog_tags (manifest_digest)",
    "CREATE TABLE IF NOT EXISTS catalog_objects (
        digest TEXT NOT NULL PRIMARY KEY,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS catalog_references (
        parent_digest TEXT NOT NULL,
        child_digest TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (parent_digest, child_digest, role)
    )",
    "CREATE INDEX IF NOT EXISTS idx_catalog_references_child
        ON catalog_references (child_digest)",
    "CREATE TABLE IF NOT EXISTS catalog_pins (
        pin_id TEXT NOT NULL PRIMARY KEY,
        manifest_digest TEXT NOT NULL,
        consumer_kind TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE (consumer_kind, consumer_id, manifest_digest)
    )",
    "CREATE INDEX IF NOT EXISTS idx_catalog_pins_digest
        ON catalog_pins (manifest_digest)",
    "CREATE TABLE IF NOT EXISTS catalog_gc_marks (
        digest TEXT NOT NULL PRIMARY KEY,
        marked_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS catalog_legacy_images (
        legacy_image_id TEXT NOT NULL PRIMARY KEY,
        legacy_digest TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        config_digest TEXT NOT NULL,
        platform TEXT NOT NULL,
        migrated_at INTEGER NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS idx_catalog_legacy_digest
        ON catalog_legacy_images (legacy_digest)",
    "CREATE TABLE IF NOT EXISTS catalog_legacy_tags (
        alias TEXT NOT NULL PRIMARY KEY,
        manifest_digest TEXT NOT NULL
    )",
];

/// Create or verify the catalog schema inside the caller's connection.
pub async fn migrate(conn: &impl ConnectionTrait) -> Result<()> {
    for statement in SCHEMA_DDL {
        conn.execute_unprepared(statement)
            .await
            .with_context(|| format!("failed to apply catalog schema: {statement}"))?;
    }
    let rows = query_all(
        conn,
        "SELECT version FROM catalog_schema LIMIT 1",
        Vec::new(),
    )
    .await?;
    match rows.first() {
        None => {
            execute(
                conn,
                "INSERT INTO catalog_schema (version) VALUES (?)",
                vec![CATALOG_SCHEMA_VERSION.into()],
            )
            .await?;
        }
        Some(row) => {
            let version: i64 = row
                .try_get("", "version")
                .context("catalog_schema.version is not an integer")?;
            if version != CATALOG_SCHEMA_VERSION {
                anyhow::bail!(
                    "catalog schema version {version} is not supported (expected {CATALOG_SCHEMA_VERSION})"
                );
            }
        }
    }
    Ok(())
}

/// Execute one parameterized statement and return the affected row count.
pub async fn execute(conn: &impl ConnectionTrait, sql: &str, values: Vec<Value>) -> Result<u64> {
    let statement = Statement::from_sql_and_values(DbBackend::Sqlite, sql, values);
    conn.execute_raw(statement)
        .await
        .map(|result| result.rows_affected())
        .with_context(|| format!("catalog SQL failed: {sql}"))
}

/// Run one parameterized query.
pub async fn query_all(
    conn: &impl ConnectionTrait,
    sql: &str,
    values: Vec<Value>,
) -> Result<Vec<QueryResult>> {
    let statement = Statement::from_sql_and_values(DbBackend::Sqlite, sql, values);
    conn.query_all_raw(statement)
        .await
        .with_context(|| format!("catalog SQL failed: {sql}"))
}

/// Whether a SQLite table exists in this connection.
pub async fn table_exists(conn: &impl ConnectionTrait, name: &str) -> Result<bool> {
    let rows = query_all(
        conn,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        vec![name.into()],
    )
    .await?;
    Ok(!rows.is_empty())
}

/// Begin one catalog transaction on the Server connection.
pub async fn begin(conn: &sea_orm::DatabaseConnection) -> Result<sea_orm::DatabaseTransaction> {
    conn.begin()
        .await
        .context("failed to begin catalog transaction")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sea_orm::{ConnectOptions, Database, DatabaseConnection};

    /// One in-memory SQLite database on one connection, matching the Server's
    /// singleton connection policy and keeping `:memory:` alive.
    pub(crate) async fn memory_connection() -> DatabaseConnection {
        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1).sqlx_logging(false);
        Database::connect(options).await.unwrap()
    }

    /// One file-backed SQLite connection that can be closed and reopened.
    pub(crate) async fn file_connection(path: &std::path::Path) -> DatabaseConnection {
        let mut options =
            ConnectOptions::new(format!("sqlite://{}?mode=rwc", path.to_string_lossy()));
        options.max_connections(1).sqlx_logging(false);
        Database::connect(options).await.unwrap()
    }

    #[tokio::test]
    async fn migrate_is_idempotent_and_records_one_version() {
        let conn = memory_connection().await;
        migrate(&conn).await.unwrap();
        migrate(&conn).await.unwrap();
        let rows = query_all(&conn, "SELECT version FROM catalog_schema", Vec::new())
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows.first().unwrap().try_get::<i64>("", "version").unwrap(),
            CATALOG_SCHEMA_VERSION
        );
        assert!(table_exists(&conn, "catalog_tags").await.unwrap());
        assert!(table_exists(&conn, "catalog_legacy_images").await.unwrap());
    }

    #[tokio::test]
    async fn a_future_schema_version_is_refused() {
        let conn = memory_connection().await;
        migrate(&conn).await.unwrap();
        execute(&conn, "UPDATE catalog_schema SET version = 99", Vec::new())
            .await
            .unwrap();
        assert!(migrate(&conn).await.is_err());
    }
}
