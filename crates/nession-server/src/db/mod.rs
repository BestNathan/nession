//! Server database layer, backed by SeaORM over SQLite.
//!
//! The public `Database` API is unchanged from the previous rusqlite
//! implementation (method names + argument shapes) so callers in `registry/`
//! and `server/handler.rs` need no edits.  The concrete `Result` alias moved
//! from `rusqlite::Result` to `anyhow::Result`; callers only format errors, so
//! this is source-compatible.  Schema is managed by SeaORM migrations (see
//! [`migration`]).
//!
//! Integer columns use SQLite's native `i32`/`i64` affinity; the DAO converts
//! to/from the `u16`/`u32` shapes the domain types use.

pub mod entities;
pub mod migration;
pub mod schema;

use anyhow::{Context, Result};
use entities::{agents, env_files, quick_commands, sessions};
use migration::Migrator;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectOptions, ConnectionTrait,
    DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};
use sea_orm_migration::MigratorTrait;

pub struct Database {
    conn: DatabaseConnection,
}

#[derive(Debug, Clone)]
pub struct AgentRow {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub registered_at: i64,
    pub last_heartbeat: i64,
    pub status: String,
    pub auth_token_hash: String,
    pub metadata: String,
    /// Human-readable display name (nullable). Set via agent config or Web UI
    /// rename. When NULL the UI falls back to hostname.
    pub display_name: Option<String>,
    /// Public WebSocket URL (nullable). Persisted so it survives restarts
    /// (previously in-memory only — issue #43).
    pub connect_url: Option<String>,
    /// JSON-encoded `Vec<AgentAddress>` of advertised endpoints. Empty string
    /// or "[]" when the agent advertised none.
    pub addresses: String,
}

/// Borrowed parameters for [`Database::insert_agent`], grouped to keep the
/// call signature small.
#[derive(Debug, Clone, Copy)]
pub struct AgentInsert<'a> {
    pub agent_id: &'a str,
    pub hostname: &'a str,
    pub ip_address: &'a str,
    pub port: u16,
    pub auth_token_hash: &'a str,
    pub metadata: &'a str,
    pub display_name: Option<&'a str>,
    pub connect_url: Option<&'a str>,
    /// JSON-encoded `Vec<AgentAddress>`.
    pub addresses: &'a str,
}

#[derive(Debug, Clone)]
pub struct SessionRow {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub created_at: i64,
    pub last_activity: i64,
    pub status: String,
    pub window_count: u32,
    pub attached_clients: u32,
    pub metadata: String,
}

/// A server-managed env file row (issue #95, part 2).
#[derive(Debug, Clone)]
pub struct EnvFileRow {
    pub name: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A user-defined quick command row (issue #95, part 3).
#[derive(Debug, Clone)]
pub struct QuickCommandRow {
    pub id: String,
    pub label: String,
    pub command: String,
    pub raw: bool,
    pub sort_order: i32,
    pub created_at: i64,
}

impl Database {
    /// Open (or create) the SQLite database at `db_path`, enable WAL, and run
    /// all pending migrations.  Accepts a plain filesystem path or a
    /// `sqlite:`-prefixed URL; `:memory:` maps to an in-memory DB.
    pub async fn new(db_path: &str) -> Result<Self> {
        let url = normalize_sqlite_url(db_path);
        let mut opts = ConnectOptions::new(&url);
        // Serialize onto one connection. This matches the old single
        // `Mutex<Connection>` design, keeps SQLite write-lock contention out
        // of the picture, and (crucially for `:memory:`) keeps a single shared
        // in-memory database alive rather than giving each pooled connection
        // its own empty DB.
        opts.max_connections(1).sqlx_logging(false);

        let conn = sea_orm::Database::connect(opts)
            .await
            .with_context(|| format!("failed to open database at {db_path}"))?;

        // Enable WAL for crash-safety (no-op for in-memory DBs).
        if !db_path.contains(":memory:") {
            conn.execute_unprepared("PRAGMA journal_mode=WAL;")
                .await
                .context("failed to enable WAL mode")?;
        }

        Migrator::up(&conn, None)
            .await
            .context("failed to run database migrations")?;

        Ok(Self { conn })
    }

    pub async fn insert_agent(&self, agent: AgentInsert<'_>) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let model = agents::ActiveModel {
            agent_id: Set(agent.agent_id.to_owned()),
            hostname: Set(agent.hostname.to_owned()),
            ip_address: Set(agent.ip_address.to_owned()),
            port: Set(i32::from(agent.port)),
            registered_at: Set(now),
            last_heartbeat: Set(now),
            status: Set("online".to_owned()),
            auth_token_hash: Set(agent.auth_token_hash.to_owned()),
            metadata: Set(Some(agent.metadata.to_owned())),
            display_name: Set(agent.display_name.map(str::to_owned)),
            connect_url: Set(agent.connect_url.map(str::to_owned)),
            addresses: Set(Some(agent.addresses.to_owned())),
        };
        // INSERT OR REPLACE semantics: overwrite the whole row on PK conflict.
        agents::Entity::insert(model)
            .on_conflict(
                OnConflict::column(agents::Column::AgentId)
                    .update_columns([
                        agents::Column::Hostname,
                        agents::Column::IpAddress,
                        agents::Column::Port,
                        agents::Column::RegisteredAt,
                        agents::Column::LastHeartbeat,
                        agents::Column::Status,
                        agents::Column::AuthTokenHash,
                        agents::Column::Metadata,
                        agents::Column::DisplayName,
                        agents::Column::ConnectUrl,
                        agents::Column::Addresses,
                    ])
                    .to_owned(),
            )
            .exec(&self.conn)
            .await
            .context("failed to insert agent")?;
        Ok(())
    }

    /// Update (or clear) the display name for an agent.  Pass `None` to remove
    /// the override and fall back to the config/hostname chain.
    pub async fn update_agent_display_name(
        &self,
        agent_id: &str,
        display_name: Option<&str>,
    ) -> Result<()> {
        agents::Entity::update_many()
            .col_expr(
                agents::Column::DisplayName,
                Expr::value(display_name.map(str::to_owned)),
            )
            .filter(agents::Column::AgentId.eq(agent_id))
            .exec(&self.conn)
            .await
            .context("failed to update agent display name")?;
        Ok(())
    }

    pub async fn list_agents(&self) -> Result<Vec<AgentRow>> {
        let rows = agents::Entity::find()
            .all(&self.conn)
            .await
            .context("failed to list agents")?;
        Ok(rows.into_iter().map(agent_row_from_model).collect())
    }

    pub async fn insert_session(
        &self,
        session: &crate::registry::session::SessionInfo,
        status: &str,
    ) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let model = sessions::ActiveModel {
            session_id: Set(session.session_id.clone()),
            agent_id: Set(session.agent_id.clone()),
            session_name: Set(session.session_name.clone()),
            created_at: Set(session.created_at.timestamp()),
            last_activity: Set(now),
            status: Set(status.to_owned()),
            window_count: Set(i32::try_from(session.window_count).unwrap_or(0)),
            attached_clients: Set(i32::try_from(session.attached_clients).unwrap_or(0)),
            metadata: Set(Some(String::new())),
        };
        sessions::Entity::insert(model)
            .on_conflict(
                OnConflict::column(sessions::Column::SessionId)
                    .update_columns([
                        sessions::Column::AgentId,
                        sessions::Column::SessionName,
                        sessions::Column::CreatedAt,
                        sessions::Column::LastActivity,
                        sessions::Column::Status,
                        sessions::Column::WindowCount,
                        sessions::Column::AttachedClients,
                        sessions::Column::Metadata,
                    ])
                    .to_owned(),
            )
            .exec(&self.conn)
            .await
            .context("failed to insert session")?;
        Ok(())
    }

    pub async fn update_session_status(&self, session_id: &str, status: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        sessions::Entity::update_many()
            .col_expr(sessions::Column::Status, Expr::value(status.to_owned()))
            .col_expr(sessions::Column::LastActivity, Expr::value(now))
            .filter(sessions::Column::SessionId.eq(session_id))
            .exec(&self.conn)
            .await
            .context("failed to update session status")?;
        Ok(())
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        sessions::Entity::delete_many()
            .filter(sessions::Column::SessionId.eq(session_id))
            .exec(&self.conn)
            .await
            .context("failed to delete session")?;
        Ok(())
    }

    pub async fn delete_sessions_by_agent(&self, agent_id: &str) -> Result<()> {
        sessions::Entity::delete_many()
            .filter(sessions::Column::AgentId.eq(agent_id))
            .exec(&self.conn)
            .await
            .context("failed to delete sessions by agent")?;
        Ok(())
    }

    pub async fn list_all_sessions(&self) -> Result<Vec<SessionRow>> {
        let rows = sessions::Entity::find()
            .all(&self.conn)
            .await
            .context("failed to list sessions")?;
        Ok(rows.into_iter().map(session_row_from_model).collect())
    }

    pub async fn list_sessions_older_than(&self, duration_secs: i64) -> Result<Vec<SessionRow>> {
        let cutoff = chrono::Utc::now().timestamp() - duration_secs;
        let rows = sessions::Entity::find()
            .filter(sessions::Column::LastActivity.lt(cutoff))
            .filter(sessions::Column::Status.eq("recovering"))
            .all(&self.conn)
            .await
            .context("failed to list stale sessions")?;
        Ok(rows.into_iter().map(session_row_from_model).collect())
    }

    // ── Env files (issue #95, part 2) ─────────────────────────────────

    /// List all server env files, ordered by name (case-insensitive).
    pub async fn list_env_files(&self) -> Result<Vec<EnvFileRow>> {
        let rows = env_files::Entity::find()
            .all(&self.conn)
            .await
            .context("failed to list env files")?;
        let mut out: Vec<EnvFileRow> = rows.into_iter().map(env_file_row_from_model).collect();
        out.sort_by_key(|f| f.name.to_lowercase());
        Ok(out)
    }

    /// Read one env file by name. `None` if absent.
    pub async fn get_env_file(&self, name: &str) -> Result<Option<EnvFileRow>> {
        let row = env_files::Entity::find_by_id(name.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read env file")?;
        Ok(row.map(env_file_row_from_model))
    }

    /// Insert or overwrite an env file, preserving `created_at` on overwrite.
    pub async fn upsert_env_file(&self, name: &str, content: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let created_at = match self.get_env_file(name).await? {
            Some(existing) => existing.created_at,
            None => now,
        };
        let model = env_files::ActiveModel {
            name: Set(name.to_owned()),
            content: Set(content.to_owned()),
            created_at: Set(created_at),
            updated_at: Set(now),
        };
        env_files::Entity::insert(model)
            .on_conflict(
                OnConflict::column(env_files::Column::Name)
                    .update_columns([env_files::Column::Content, env_files::Column::UpdatedAt])
                    .to_owned(),
            )
            .exec(&self.conn)
            .await
            .context("failed to upsert env file")?;
        Ok(())
    }

    /// Delete an env file by name (idempotent).
    pub async fn delete_env_file(&self, name: &str) -> Result<()> {
        env_files::Entity::delete_by_id(name.to_owned())
            .exec(&self.conn)
            .await
            .context("failed to delete env file")?;
        Ok(())
    }

    // ── Quick commands (issue #95, part 3) ────────────────────────────

    /// List all quick commands, ordered by `sort_order` then `created_at`.
    pub async fn list_quick_commands(&self) -> Result<Vec<QuickCommandRow>> {
        let rows = quick_commands::Entity::find()
            .order_by_asc(quick_commands::Column::SortOrder)
            .order_by_asc(quick_commands::Column::CreatedAt)
            .all(&self.conn)
            .await
            .context("failed to list quick commands")?;
        Ok(rows.into_iter().map(quick_command_row_from_model).collect())
    }

    /// Insert or replace a quick command (by `id`).
    pub async fn upsert_quick_command(&self, cmd: &QuickCommandRow) -> Result<()> {
        let model = quick_commands::ActiveModel {
            id: Set(cmd.id.clone()),
            label: Set(cmd.label.clone()),
            command: Set(cmd.command.clone()),
            raw: Set(cmd.raw),
            sort_order: Set(cmd.sort_order),
            created_at: Set(cmd.created_at),
        };
        quick_commands::Entity::insert(model)
            .on_conflict(
                OnConflict::column(quick_commands::Column::Id)
                    .update_columns([
                        quick_commands::Column::Label,
                        quick_commands::Column::Command,
                        quick_commands::Column::Raw,
                        quick_commands::Column::SortOrder,
                    ])
                    .to_owned(),
            )
            .exec(&self.conn)
            .await
            .context("failed to upsert quick command")?;
        Ok(())
    }

    /// Update fields of an existing quick command. `None` fields are left
    /// unchanged. Returns `false` if no row matched.
    pub async fn update_quick_command(
        &self,
        id: &str,
        label: Option<&str>,
        command: Option<&str>,
        raw: Option<bool>,
    ) -> Result<bool> {
        let Some(existing) = quick_commands::Entity::find_by_id(id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to load quick command for update")?
        else {
            return Ok(false);
        };
        let mut model: quick_commands::ActiveModel = existing.into();
        if let Some(l) = label {
            model.label = Set(l.to_owned());
        }
        if let Some(c) = command {
            model.command = Set(c.to_owned());
        }
        if let Some(r) = raw {
            model.raw = Set(r);
        }
        model
            .update(&self.conn)
            .await
            .context("failed to update quick command")?;
        Ok(true)
    }

    /// Delete a quick command by id (idempotent). Returns `true` if a row was
    /// removed.
    pub async fn delete_quick_command(&self, id: &str) -> Result<bool> {
        let res = quick_commands::Entity::delete_by_id(id.to_owned())
            .exec(&self.conn)
            .await
            .context("failed to delete quick command")?;
        Ok(res.rows_affected > 0)
    }
}

/// Normalize a path or URL into a SeaORM SQLite connection URL.
fn normalize_sqlite_url(db_path: &str) -> String {
    if db_path.starts_with("sqlite:") {
        return db_path.to_owned();
    }
    if db_path == ":memory:" {
        return "sqlite::memory:".to_owned();
    }
    // `mode=rwc` creates the file if it doesn't exist.
    format!("sqlite://{db_path}?mode=rwc")
}

fn agent_row_from_model(m: agents::Model) -> AgentRow {
    AgentRow {
        agent_id: m.agent_id,
        hostname: m.hostname,
        ip_address: m.ip_address,
        port: u16::try_from(m.port).unwrap_or(0),
        registered_at: m.registered_at,
        last_heartbeat: m.last_heartbeat,
        status: m.status,
        auth_token_hash: m.auth_token_hash,
        metadata: m.metadata.unwrap_or_default(),
        display_name: m.display_name,
        connect_url: m.connect_url,
        addresses: m.addresses.unwrap_or_default(),
    }
}

fn session_row_from_model(m: sessions::Model) -> SessionRow {
    SessionRow {
        session_id: m.session_id,
        agent_id: m.agent_id,
        session_name: m.session_name,
        created_at: m.created_at,
        last_activity: m.last_activity,
        status: m.status,
        window_count: u32::try_from(m.window_count).unwrap_or(0),
        attached_clients: u32::try_from(m.attached_clients).unwrap_or(0),
        metadata: m.metadata.unwrap_or_default(),
    }
}

fn env_file_row_from_model(m: env_files::Model) -> EnvFileRow {
    EnvFileRow {
        name: m.name,
        content: m.content,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

fn quick_command_row_from_model(m: quick_commands::Model) -> QuickCommandRow {
    QuickCommandRow {
        id: m.id,
        label: m.label,
        command: m.command,
        raw: m.raw,
        sort_order: m.sort_order,
        created_at: m.created_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::session::{SessionInfo, SessionStatus};

    async fn new_db() -> Database {
        Database::new(":memory:").await.unwrap()
    }

    // ── Agents ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn insert_and_list_agents() {
        let db = new_db().await;
        assert!(db.list_agents().await.unwrap().is_empty());

        db.insert_agent(AgentInsert {
            agent_id: "a1",
            hostname: "host1",
            ip_address: "10.0.0.1",
            port: 19090,
            auth_token_hash: "tok",
            metadata: "{}",
            display_name: None,
            connect_url: None,
            addresses: "[]",
        })
        .await
        .unwrap();

        let agents = db.list_agents().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].agent_id, "a1");
        assert_eq!(agents[0].hostname, "host1");
        assert_eq!(agents[0].status, "online");
    }

    #[tokio::test]
    async fn upsert_agent_overwrites() {
        let db = new_db().await;

        db.insert_agent(AgentInsert {
            agent_id: "a1",
            hostname: "old",
            ip_address: "10.0.0.1",
            port: 19090,
            auth_token_hash: "tok",
            metadata: "{}",
            display_name: None,
            connect_url: None,
            addresses: "[]",
        })
        .await
        .unwrap();

        db.insert_agent(AgentInsert {
            agent_id: "a1",
            hostname: "new",
            ip_address: "10.0.0.2",
            port: 19091,
            auth_token_hash: "tok",
            metadata: "{}",
            display_name: None,
            connect_url: None,
            addresses: "[]",
        })
        .await
        .unwrap();

        let agents = db.list_agents().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].hostname, "new");
        assert_eq!(agents[0].port, 19091);
    }

    #[tokio::test]
    async fn update_agent_display_name() {
        let db = new_db().await;

        db.insert_agent(AgentInsert {
            agent_id: "a1",
            hostname: "h",
            ip_address: "10.0.0.1",
            port: 19090,
            auth_token_hash: "tok",
            metadata: "{}",
            display_name: None,
            connect_url: None,
            addresses: "[]",
        })
        .await
        .unwrap();

        db.update_agent_display_name("a1", Some("My Agent"))
            .await
            .unwrap();
        let agents = db.list_agents().await.unwrap();
        assert_eq!(agents[0].display_name.as_deref(), Some("My Agent"));

        db.update_agent_display_name("a1", None).await.unwrap();
        let agents = db.list_agents().await.unwrap();
        assert!(agents[0].display_name.is_none());
    }

    // ── Sessions ──────────────────────────────────────────────────────

    fn sess_info(id: &str, status: SessionStatus) -> SessionInfo {
        SessionInfo {
            session_id: id.to_owned(),
            agent_id: "a1".to_owned(),
            session_name: id.to_owned(),
            status,
            window_count: 2,
            attached_clients: 0,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn insert_and_list_sessions() {
        let db = new_db().await;

        let s = sess_info("sess1", SessionStatus::Active);
        db.insert_session(&s, "active").await.unwrap();

        let rows = db.list_all_sessions().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "sess1");
        assert_eq!(rows[0].status, "active");
    }

    #[tokio::test]
    async fn update_session_status() {
        let db = new_db().await;

        let s = sess_info("s1", SessionStatus::Active);
        db.insert_session(&s, "active").await.unwrap();

        db.update_session_status("s1", "detached").await.unwrap();
        let rows = db.list_all_sessions().await.unwrap();
        assert_eq!(rows[0].status, "detached");
    }

    #[tokio::test]
    async fn delete_session() {
        let db = new_db().await;

        let s = sess_info("s1", SessionStatus::Active);
        db.insert_session(&s, "active").await.unwrap();
        db.delete_session("s1").await.unwrap();

        assert!(db.list_all_sessions().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_sessions_by_agent() {
        let db = new_db().await;

        let s1 = sess_info("s1", SessionStatus::Active);
        db.insert_session(&s1, "active").await.unwrap();
        let s2 = sess_info("s2", SessionStatus::Detached);
        db.insert_session(&s2, "detached").await.unwrap();

        db.delete_sessions_by_agent("a1").await.unwrap();
        assert!(db.list_all_sessions().await.unwrap().is_empty());
    }

    // ── Env files ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn env_file_crud() {
        let db = new_db().await;

        assert!(db.list_env_files().await.unwrap().is_empty());
        assert!(db.get_env_file("test.env").await.unwrap().is_none());

        db.upsert_env_file("test.env", "FOO=bar").await.unwrap();

        let files = db.list_env_files().await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "test.env");
        assert_eq!(files[0].content, "FOO=bar");

        let got = db.get_env_file("test.env").await.unwrap().unwrap();
        assert_eq!(got.content, "FOO=bar");

        db.upsert_env_file("test.env", "BAR=baz").await.unwrap();
        let got = db.get_env_file("test.env").await.unwrap().unwrap();
        assert_eq!(got.content, "BAR=baz");

        db.delete_env_file("test.env").await.unwrap();
        assert!(db.list_env_files().await.unwrap().is_empty());
    }

    // ── Quick commands ────────────────────────────────────────────────

    #[tokio::test]
    async fn quick_command_crud() {
        let db = new_db().await;

        assert!(db.list_quick_commands().await.unwrap().is_empty());

        let cmd = QuickCommandRow {
            id: "cmd1".to_owned(),
            label: "ls".to_owned(),
            command: "ls -la".to_owned(),
            raw: false,
            sort_order: 0,
            created_at: 1000,
        };
        db.upsert_quick_command(&cmd).await.unwrap();

        let cmds = db.list_quick_commands().await.unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].label, "ls");

        db.update_quick_command("cmd1", Some("List"), None, None)
            .await
            .unwrap();
        let cmds = db.list_quick_commands().await.unwrap();
        assert_eq!(cmds[0].label, "List");

        db.delete_quick_command("cmd1").await.unwrap();
        assert!(db.list_quick_commands().await.unwrap().is_empty());
    }

    // ── Restart survival (issue #95, success criterion #1) ────────────

    #[tokio::test]
    async fn restart_survival() {
        // Use a temp file so we can "restart" by opening a new Database.
        let path = format!("/tmp/nession_test_restart_{}.db", uuid::Uuid::new_v4());
        let env_created_at;

        // ── First session ────────────────────────────────────────
        {
            let db = Database::new(&path).await.unwrap();

            db.insert_agent(AgentInsert {
                agent_id: "survive-agent",
                hostname: "h",
                ip_address: "10.0.0.1",
                port: 19090,
                auth_token_hash: "tok",
                metadata: "{}",
                display_name: Some("survivor"),
                connect_url: Some("ws://10.0.0.1:19090"),
                addresses: "[]",
            })
            .await
            .unwrap();

            db.upsert_env_file("prod.env", "ENV=production")
                .await
                .unwrap();

            let cmd = QuickCommandRow {
                id: "survive-cmd".to_owned(),
                label: "restart-test".to_owned(),
                command: "echo survive".to_owned(),
                raw: false,
                sort_order: 1,
                created_at: 2000,
            };
            db.upsert_quick_command(&cmd).await.unwrap();
            env_created_at = db
                .get_env_file("prod.env")
                .await
                .unwrap()
                .unwrap()
                .updated_at;
        }

        // ── "Restart" — new Database on the same file ────────────
        {
            let db = Database::new(&path).await.unwrap();

            // Agent row restored.
            let agents = db.list_agents().await.unwrap();
            assert_eq!(agents.len(), 1, "agent row must survive restart");
            assert_eq!(agents[0].agent_id, "survive-agent");
            assert_eq!(agents[0].display_name.as_deref(), Some("survivor"));
            assert_eq!(
                agents[0].connect_url.as_deref(),
                Some("ws://10.0.0.1:19090")
            );

            // Env file readable.
            let env = db.get_env_file("prod.env").await.unwrap().unwrap();
            assert_eq!(env.content, "ENV=production");
            assert_eq!(env.updated_at, env_created_at, "timestamp preserved");

            // Quick command persisted.
            let cmds = db.list_quick_commands().await.unwrap();
            assert_eq!(cmds.len(), 1);
            assert_eq!(cmds[0].label, "restart-test");
            assert_eq!(cmds[0].command, "echo survive");
        }

        std::fs::remove_file(&path).ok();
        std::fs::remove_file(format!("{path}-wal")).ok();
        std::fs::remove_file(format!("{path}-shm")).ok();
    }

    // ── Migration from old-format DB ──────────────────────────────────

    #[tokio::test]
    async fn migration_from_old_db() {
        // Craft a DB file with the old ad-hoc schema (agents table missing
        // display_name, connect_url, addresses) and verify the SeaORM
        // migration upgrades it.
        let path = format!("/tmp/nession_test_migrate_{}.db", uuid::Uuid::new_v4());

        // Create a DB with the minimal old schema using a bare connection
        // (no migrations run).
        {
            let raw = sea_orm::Database::connect(format!("sqlite://{path}?mode=rwc"))
                .await
                .unwrap();
            for stmt in [
                "CREATE TABLE agents (
                    agent_id TEXT PRIMARY KEY,
                    hostname TEXT NOT NULL,
                    ip_address TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    registered_at INTEGER NOT NULL,
                    last_heartbeat INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    auth_token_hash TEXT NOT NULL,
                    metadata TEXT
                );",
                "CREATE TABLE sessions (
                    session_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    session_name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_activity INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    window_count INTEGER NOT NULL,
                    attached_clients INTEGER NOT NULL,
                    metadata TEXT
                );",
                "INSERT INTO agents (agent_id, hostname, ip_address, port, registered_at, last_heartbeat, status, auth_token_hash, metadata)
                 VALUES ('legacy', 'h', '1.2.3.4', 19090, 100, 100, 'offline', 'tok', '{}');",
                "INSERT INTO sessions (session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata)
                 VALUES ('legacy:sess', 'legacy', 'sess', 100, 100, 'active', 1, 0, '');",
            ] {
                raw.execute_unprepared(stmt).await.unwrap();
            }
        }

        // Now open with the SeaORM Database — migration should upgrade.
        let db = Database::new(&path).await.unwrap();

        // Old agent row survived.
        let agents = db.list_agents().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].agent_id, "legacy");
        assert_eq!(agents[0].hostname, "h");
        assert_eq!(agents[0].display_name, None);
        assert_eq!(agents[0].connect_url, None);
        assert_eq!(agents[0].addresses, "");

        // Old session row survived.
        let sessions = db.list_all_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "legacy:sess");

        // New tables functional.
        db.upsert_env_file("new.env", "X=1").await.unwrap();
        assert_eq!(db.list_env_files().await.unwrap().len(), 1);

        let cmd = QuickCommandRow {
            id: "migrate-cmd".to_owned(),
            label: "migrate".to_owned(),
            command: "echo ok".to_owned(),
            raw: false,
            sort_order: 0,
            created_at: 3000,
        };
        db.upsert_quick_command(&cmd).await.unwrap();
        assert_eq!(db.list_quick_commands().await.unwrap().len(), 1);

        // Cleanup.
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(format!("{path}-wal")).ok();
        std::fs::remove_file(format!("{path}-shm")).ok();
    }
}
