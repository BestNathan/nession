//! Migration m001 — initial `agents` and `sessions` tables.
//!
//! Uses `if_not_exists` so pre-existing databases (created by the old
//! ad-hoc schema) are not clobbered.  Optional columns (`display_name`,
//! `connect_url`, `addresses`) that may be missing in very old DBs are
//! added via `ALTER TABLE ADD COLUMN` with best-effort error handling.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // ── agents table ──────────────────────────────────────────────
        let agent_builder = Table::create()
            .table(Agents::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(Agents::AgentId)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(ColumnDef::new(Agents::Hostname).string().not_null())
            .col(ColumnDef::new(Agents::IpAddress).string().not_null())
            .col(ColumnDef::new(Agents::Port).integer().not_null())
            .col(
                ColumnDef::new(Agents::RegisteredAt)
                    .big_integer()
                    .not_null(),
            )
            .col(
                ColumnDef::new(Agents::LastHeartbeat)
                    .big_integer()
                    .not_null(),
            )
            .col(ColumnDef::new(Agents::Status).string().not_null())
            .col(ColumnDef::new(Agents::AuthTokenHash).string().not_null())
            .col(ColumnDef::new(Agents::Metadata).string())
            .col(ColumnDef::new(Agents::DisplayName).string())
            .col(ColumnDef::new(Agents::ConnectUrl).string())
            .col(ColumnDef::new(Agents::Addresses).string())
            .to_owned();
        manager.create_table(agent_builder).await?;

        // Index on agent status for fast filtering.
        let idx = Index::create()
            .name("idx_agents_status")
            .table(Agents::Table)
            .col(Agents::Status)
            .to_owned();
        manager.create_index(idx).await.unwrap_or(());

        // ── sessions table ────────────────────────────────────────────
        let session_builder = Table::create()
            .table(Sessions::Table)
            .if_not_exists()
            .col(
                ColumnDef::new(Sessions::SessionId)
                    .string()
                    .not_null()
                    .primary_key(),
            )
            .col(ColumnDef::new(Sessions::AgentId).string().not_null())
            .col(ColumnDef::new(Sessions::SessionName).string().not_null())
            .col(ColumnDef::new(Sessions::CreatedAt).big_integer().not_null())
            .col(
                ColumnDef::new(Sessions::LastActivity)
                    .big_integer()
                    .not_null(),
            )
            .col(ColumnDef::new(Sessions::Status).string().not_null())
            .col(ColumnDef::new(Sessions::WindowCount).integer().not_null())
            .col(
                ColumnDef::new(Sessions::AttachedClients)
                    .integer()
                    .not_null(),
            )
            .col(ColumnDef::new(Sessions::Metadata).string())
            .to_owned();
        manager.create_table(session_builder).await?;

        // Index on session agent_id for fast lookup.
        let idx2 = Index::create()
            .name("idx_sessions_agent_id")
            .table(Sessions::Table)
            .col(Sessions::AgentId)
            .to_owned();
        manager.create_index(idx2).await.unwrap_or(());

        // ── Backfill optional columns missing in very old DBs ─────────
        // The old ad-hoc code added these columns via ALTER TABLE ADD COLUMN
        // with best-effort error handling.  We mimic that for DBs created
        // before the schema was updated to include them in CREATE TABLE.
        for col in &[
            ("display_name", "TEXT"),
            ("connect_url", "TEXT"),
            ("addresses", "TEXT"),
        ] {
            add_column_if_missing(manager, "agents", col.0, col.1).await;
        }

        Ok(())
    }
}

#[derive(Iden)]
pub enum Agents {
    Table,
    AgentId,
    Hostname,
    IpAddress,
    Port,
    RegisteredAt,
    LastHeartbeat,
    Status,
    AuthTokenHash,
    Metadata,
    DisplayName,
    ConnectUrl,
    Addresses,
}

#[derive(Iden)]
pub enum Sessions {
    Table,
    SessionId,
    AgentId,
    SessionName,
    CreatedAt,
    LastActivity,
    Status,
    WindowCount,
    AttachedClients,
    Metadata,
}

/// Add a column to a table, ignoring "duplicate column" errors.
async fn add_column_if_missing(
    manager: &SchemaManager<'_>,
    table: &str,
    column: &str,
    col_type: &str,
) {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {col_type}");
    match manager.get_connection().execute_unprepared(&sql).await {
        Ok(_) => tracing::info!("Migrated {table}: added column {column}"),
        Err(e) => {
            let msg = e.to_string();
            if !msg.contains("duplicate column") && !msg.contains("already exists") {
                tracing::warn!("Migration ALTER TABLE {table} ADD {column} failed: {msg}");
            }
        }
    }
}
