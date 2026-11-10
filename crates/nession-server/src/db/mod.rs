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
mod images;
pub mod migration;
pub mod schema;

use anyhow::{Context, Result};
use entities::{
    agents, env_files, projects, quick_commands, session_env_bindings, session_project_bindings,
    sessions,
};
pub use images::{ImageGrantRow, ImageLeaseRow, ImageRow, ImageStatusCounts};
use migration::Migrator;
use nession_protocol::contracts::project::v1::{
    ProjectLocation, ProjectSessionDefaults, ProjectSource,
};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectOptions, ConnectionTrait,
    DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, TransactionTrait,
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
    pub instance_id: Option<String>,
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

/// One Session's desired Environment Binding (#170 Phase A).
#[derive(Debug, Clone)]
pub struct SessionEnvBindingRow {
    pub session_id: String,
    pub agent_id: String,
    pub desired_revision: u64,
    /// JSON-encoded ordered materialized profiles.
    pub profiles_json: String,
    pub updated_at: i64,
}

/// One Session's explicit Project membership (#3082).
///
/// The row is keyed by the recyclable `agent_id:session_name`; the
/// `agent_created_at` tmux creation time is what distinguishes incarnations.
/// `0` means the create ACK has not yet been reconciled with the Agent report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionProjectBindingRow {
    pub session_id: String,
    pub agent_id: String,
    pub project_id: String,
    /// Durable tmux instance identity; empty until the first Agent report.
    pub incarnation_id: String,
    /// Fallback tmux creation time; `0` until the first Agent report.
    pub agent_created_at: i64,
    pub revision: u64,
    pub updated_at: i64,
}

/// One persisted Project (#3021).
///
/// The row is the Server's durable declaration. `source`, `locations` and
/// `session_defaults` are stored as JSON because the Server is the only writer
/// and the API's canonical validation rejects anything it could not have
/// written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: Option<ProjectSource>,
    pub locations: Vec<ProjectLocation>,
    pub session_defaults: Option<ProjectSessionDefaults>,
    pub image_digest: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
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
        let model = session_active_model(session, status, chrono::Utc::now().timestamp());
        sessions::Entity::insert(model)
            .on_conflict(session_upsert_columns())
            .exec(&self.conn)
            .await
            .context("failed to insert session")?;
        Ok(())
    }

    /// Replace one Agent's persisted Session set in **one transaction**.
    ///
    /// The force-refresh projection used to be a delete followed by N
    /// independent inserts. Even with the in-memory swap atomic, a crash or
    /// concurrent writer could therefore observe a half-replaced set, and a
    /// late refresh could interleave its statements with a newer Agent report
    /// (#2874). Serialization against live updates is owned by
    /// `SessionRegistry`; this method only guarantees that once the projection
    /// starts it is all-or-nothing on disk.
    pub async fn replace_sessions_for_agent(
        &self,
        agent_id: &str,
        replacement: &[crate::registry::session::SessionInfo],
    ) -> Result<()> {
        let txn = self
            .conn
            .begin()
            .await
            .context("failed to begin session replacement")?;

        sessions::Entity::delete_many()
            .filter(sessions::Column::AgentId.eq(agent_id))
            .exec(&txn)
            .await
            .context("failed to clear sessions by agent")?;

        let now = chrono::Utc::now().timestamp();
        for session in replacement {
            let model = session_active_model(
                session,
                crate::registry::session::status_str(&session.status),
                now,
            );
            if let Err(e) = sessions::Entity::insert(model)
                .on_conflict(session_upsert_columns())
                .exec(&txn)
                .await
                .context("failed to insert replacement session")
            {
                // Keep the previous set intact rather than leaving a partial
                // replacement behind.
                if let Err(rollback) = txn.rollback().await {
                    tracing::error!(
                        "Failed to roll back session replacement for agent {}: {:#}",
                        agent_id,
                        rollback
                    );
                }
                return Err(e);
            }
        }

        txn.commit()
            .await
            .context("failed to commit session replacement")?;
        // The projection is this Agent's complete live set: removed Sessions
        // lose their membership and present ones adopt/invalidate by
        // incarnation (#3082 SC-02).
        let live: Vec<(String, Option<String>, Option<i64>)> = replacement
            .iter()
            .map(|session| {
                (
                    session.session_id.clone(),
                    session.instance_id.clone(),
                    Some(session.created_at.timestamp()),
                )
            })
            .collect();
        self.reconcile_session_project_bindings(agent_id, &live)
            .await?;
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
        let txn = self
            .conn
            .begin()
            .await
            .context("failed to begin session deletion")?;
        session_project_bindings::Entity::delete_by_id(session_id.to_owned())
            .exec(&txn)
            .await
            .context("failed to delete session project binding")?;
        sessions::Entity::delete_many()
            .filter(sessions::Column::SessionId.eq(session_id))
            .exec(&txn)
            .await
            .context("failed to delete session")?;
        txn.commit()
            .await
            .context("failed to commit session deletion")?;
        Ok(())
    }

    /// Remove one Agent's Session recovery rows without touching durable
    /// Project memberships.
    ///
    /// Reconnect, re-registration and offline grace call this path while the
    /// tmux Sessions may still exist; clearing memberships here would violate
    /// #3082 SC-02. Confirmed destruction (single `remove`, force-refresh
    /// absence, stale sweep) owns membership deletion instead.
    pub async fn delete_sessions_by_agent(&self, agent_id: &str) -> Result<()> {
        sessions::Entity::delete_many()
            .filter(sessions::Column::AgentId.eq(agent_id))
            .exec(&self.conn)
            .await
            .context("failed to delete sessions by agent")?;
        Ok(())
    }

    /// Remove one Agent's Sessions **and** durable memberships. Only an
    /// explicit Agent deletion may use this.
    pub async fn delete_sessions_and_project_bindings_by_agent(
        &self,
        agent_id: &str,
    ) -> Result<()> {
        let txn = self
            .conn
            .begin()
            .await
            .context("failed to begin agent deletion")?;
        session_project_bindings::Entity::delete_many()
            .filter(session_project_bindings::Column::AgentId.eq(agent_id))
            .exec(&txn)
            .await
            .context("failed to delete agent session project bindings")?;
        sessions::Entity::delete_many()
            .filter(sessions::Column::AgentId.eq(agent_id))
            .exec(&txn)
            .await
            .context("failed to delete sessions by agent")?;
        txn.commit()
            .await
            .context("failed to commit agent deletion")?;
        Ok(())
    }

    pub async fn delete_agent(&self, agent_id: &str) -> Result<bool> {
        let result = agents::Entity::delete_many()
            .filter(agents::Column::AgentId.eq(agent_id))
            .exec(&self.conn)
            .await
            .context("failed to delete agent")?;
        Ok(result.rows_affected > 0)
    }

    pub async fn list_all_sessions(&self) -> Result<Vec<SessionRow>> {
        let rows = sessions::Entity::find()
            .all(&self.conn)
            .await
            .context("failed to list sessions")?;
        Ok(rows.into_iter().map(session_row_from_model).collect())
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Option<SessionRow>> {
        let row = sessions::Entity::find_by_id(session_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read session")?;
        Ok(row.map(session_row_from_model))
    }

    /// Rows still in `recovering` whose activity is older than `cutoff`
    /// (Unix seconds). This is the sweep's **selection** half; reclamation
    /// re-checks the same predicate at deletion (#2848).
    pub async fn list_recovering_sessions_before(&self, cutoff: i64) -> Result<Vec<SessionRow>> {
        let rows = sessions::Entity::find()
            .filter(sessions::Column::LastActivity.lt(cutoff))
            .filter(sessions::Column::Status.eq("recovering"))
            .all(&self.conn)
            .await
            .context("failed to list stale sessions")?;
        Ok(rows.into_iter().map(session_row_from_model).collect())
    }

    pub async fn list_sessions_older_than(&self, duration_secs: i64) -> Result<Vec<SessionRow>> {
        let cutoff = chrono::Utc::now().timestamp() - duration_secs;
        self.list_recovering_sessions_before(cutoff).await
    }

    /// Delete a Session row **only while it is still the stale recovering row**
    /// the sweep selected. Returns whether a row was removed.
    ///
    /// This is the destructive boundary: a restore that commits before this
    /// statement changes the row's status or activity, and the delete becomes
    /// a no-op instead of erasing the restored Session (#2848).
    pub async fn delete_recovering_session_before(
        &self,
        session_id: &str,
        cutoff: i64,
    ) -> Result<bool> {
        let result = sessions::Entity::delete_many()
            .filter(sessions::Column::SessionId.eq(session_id))
            .filter(sessions::Column::Status.eq("recovering"))
            .filter(sessions::Column::LastActivity.lt(cutoff))
            .exec(&self.conn)
            .await
            .context("failed to delete stale recovering session")?;
        Ok(result.rows_affected > 0)
    }

    /// Seed activity/status for an in-crate lifecycle test.
    #[cfg(test)]
    pub(crate) async fn set_session_activity_for_test(
        &self,
        session_id: &str,
        status: &str,
        last_activity: i64,
    ) -> Result<()> {
        sessions::Entity::update_many()
            .col_expr(sessions::Column::Status, Expr::value(status.to_owned()))
            .col_expr(sessions::Column::LastActivity, Expr::value(last_activity))
            .filter(sessions::Column::SessionId.eq(session_id))
            .exec(&self.conn)
            .await
            .context("failed to seed session activity")?;
        Ok(())
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

    // ── Session Environment Bindings (#170 Phase A) ───────────────────

    /// Read one Session's desired binding.
    pub async fn get_session_env_binding(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionEnvBindingRow>> {
        let row = session_env_bindings::Entity::find_by_id(session_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read session env binding")?;
        Ok(row.map(session_env_binding_row_from_model))
    }

    /// Insert or replace one Session's desired binding (replace-whole).
    pub async fn upsert_session_env_binding(&self, row: &SessionEnvBindingRow) -> Result<()> {
        let model = session_env_bindings::ActiveModel {
            session_id: Set(row.session_id.clone()),
            agent_id: Set(row.agent_id.clone()),
            desired_revision: Set(i64::try_from(row.desired_revision).unwrap_or(i64::MAX)),
            profiles_json: Set(row.profiles_json.clone()),
            updated_at: Set(row.updated_at),
        };
        session_env_bindings::Entity::insert(model)
            .on_conflict(
                OnConflict::column(session_env_bindings::Column::SessionId)
                    .update_columns([
                        session_env_bindings::Column::AgentId,
                        session_env_bindings::Column::DesiredRevision,
                        session_env_bindings::Column::ProfilesJson,
                        session_env_bindings::Column::UpdatedAt,
                    ])
                    .to_owned(),
            )
            .exec(&self.conn)
            .await
            .context("failed to upsert session env binding")?;
        Ok(())
    }

    /// Delete one Session's binding (idempotent).
    pub async fn delete_session_env_binding(&self, session_id: &str) -> Result<()> {
        session_env_bindings::Entity::delete_by_id(session_id.to_owned())
            .exec(&self.conn)
            .await
            .context("failed to delete session env binding")?;
        Ok(())
    }

    /// Delete every binding owned by one Agent.
    pub async fn delete_session_env_bindings_by_agent(&self, agent_id: &str) -> Result<()> {
        session_env_bindings::Entity::delete_many()
            .filter(session_env_bindings::Column::AgentId.eq(agent_id))
            .exec(&self.conn)
            .await
            .context("failed to delete agent session env bindings")?;
        Ok(())
    }

    /// Every persisted binding, for the derived usage queries.
    pub async fn list_session_env_bindings(&self) -> Result<Vec<SessionEnvBindingRow>> {
        let rows = session_env_bindings::Entity::find()
            .all(&self.conn)
            .await
            .context("failed to list session env bindings")?;
        Ok(rows
            .into_iter()
            .map(session_env_binding_row_from_model)
            .collect())
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

    // ── Session Project Bindings (#3082) ─────────────────────────────

    /// Read one Session's Project membership.
    pub async fn get_session_project_binding(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionProjectBindingRow>> {
        let row = session_project_bindings::Entity::find_by_id(session_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read session project binding")?;
        Ok(row.map(session_project_binding_row_from_model))
    }

    /// Every persisted membership. The caller filters by live Session
    /// incarnation; this is one read per list/broadcast projection.
    pub async fn list_session_project_bindings(&self) -> Result<Vec<SessionProjectBindingRow>> {
        let rows = session_project_bindings::Entity::find()
            .order_by_asc(session_project_bindings::Column::SessionId)
            .all(&self.conn)
            .await
            .context("failed to list session project bindings")?;
        Ok(rows
            .into_iter()
            .map(session_project_binding_row_from_model)
            .collect())
    }

    /// Insert or replace one Session's Project membership.
    pub async fn upsert_session_project_binding(
        &self,
        row: &SessionProjectBindingRow,
    ) -> Result<()> {
        let model = session_project_bindings::ActiveModel {
            session_id: Set(row.session_id.clone()),
            agent_id: Set(row.agent_id.clone()),
            project_id: Set(row.project_id.clone()),
            incarnation_id: Set(row.incarnation_id.clone()),
            agent_created_at: Set(row.agent_created_at),
            revision: Set(i64::try_from(row.revision).unwrap_or(i64::MAX)),
            updated_at: Set(row.updated_at),
        };
        session_project_bindings::Entity::insert(model)
            .on_conflict(
                OnConflict::column(session_project_bindings::Column::SessionId)
                    .update_columns([
                        session_project_bindings::Column::AgentId,
                        session_project_bindings::Column::ProjectId,
                        session_project_bindings::Column::IncarnationId,
                        session_project_bindings::Column::AgentCreatedAt,
                        session_project_bindings::Column::Revision,
                        session_project_bindings::Column::UpdatedAt,
                    ])
                    .to_owned(),
            )
            .exec(&self.conn)
            .await
            .context("failed to upsert session project binding")?;
        Ok(())
    }

    /// Delete one Session's Project membership (idempotent).
    pub async fn delete_session_project_binding(&self, session_id: &str) -> Result<()> {
        session_project_bindings::Entity::delete_by_id(session_id.to_owned())
            .exec(&self.conn)
            .await
            .context("failed to delete session project binding")?;
        Ok(())
    }

    /// Delete every membership owned by one Agent.
    pub async fn delete_session_project_bindings_by_agent(&self, agent_id: &str) -> Result<()> {
        session_project_bindings::Entity::delete_many()
            .filter(session_project_bindings::Column::AgentId.eq(agent_id))
            .exec(&self.conn)
            .await
            .context("failed to delete agent session project bindings")?;
        Ok(())
    }

    /// Adopt a pending create-time membership with the Agent's first report, or
    /// invalidate it when the report is a different Session incarnation.
    ///
    /// The tmux `created_at` is the incarnation identity. A binding recorded at
    /// create time carries `agent_created_at = 0` until the Agent reports; a
    /// different reported timestamp means the original Session is gone and a
    /// new one reused its name, so the membership must not be resurrected.
    pub async fn adopt_or_invalidate_session_project_binding(
        &self,
        session_id: &str,
        incarnation_id: Option<&str>,
        agent_created_at: Option<i64>,
    ) -> Result<Option<SessionProjectBindingRow>> {
        let Some(model) = session_project_bindings::Entity::find_by_id(session_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read session project binding for reconciliation")?
        else {
            return Ok(None);
        };
        let observed = incarnation_id.filter(|id| !id.is_empty());
        if let Some(observed) = observed {
            if model.incarnation_id.is_empty() {
                // A pending create-time membership adopts this incarnation.
                // A stale pending row (an ambiguous create that never produced
                // a Session) must not resurrect a Project for a later
                // same-name incarnation.
                if chrono::Utc::now()
                    .timestamp()
                    .saturating_sub(model.updated_at)
                    > 600
                {
                    session_project_bindings::Entity::delete_by_id(model.session_id)
                        .exec(&self.conn)
                        .await
                        .context("failed to expire a stale pending project binding")?;
                    return Ok(None);
                }
                let mut active: session_project_bindings::ActiveModel = model.into();
                active.incarnation_id = Set(observed.to_string());
                if let Some(created_at) = agent_created_at {
                    active.agent_created_at = Set(created_at);
                }
                active.updated_at = Set(chrono::Utc::now().timestamp());
                let updated = active
                    .update(&self.conn)
                    .await
                    .context("failed to adopt session project binding")?;
                return Ok(Some(session_project_binding_row_from_model(updated)));
            }
            if model.incarnation_id != observed {
                session_project_bindings::Entity::delete_by_id(model.session_id)
                    .exec(&self.conn)
                    .await
                    .context("failed to invalidate stale session project binding")?;
                return Ok(None);
            }
            return Ok(Some(session_project_binding_row_from_model(model)));
        }
        // No durable incarnation on this report (legacy Agent): fall back to
        // the tmux creation time only while the binding itself is fallback-
        // keyed. A durable binding is never guessed away from a missing id.
        if model.incarnation_id.is_empty() {
            if let Some(created_at) = agent_created_at {
                if model.agent_created_at == 0 {
                    let mut active: session_project_bindings::ActiveModel = model.into();
                    active.agent_created_at = Set(created_at);
                    active.updated_at = Set(chrono::Utc::now().timestamp());
                    let updated = active
                        .update(&self.conn)
                        .await
                        .context("failed to adopt a fallback project binding")?;
                    return Ok(Some(session_project_binding_row_from_model(updated)));
                }
                if model.agent_created_at != created_at {
                    session_project_bindings::Entity::delete_by_id(model.session_id)
                        .exec(&self.conn)
                        .await
                        .context("failed to invalidate a fallback session project binding")?;
                    return Ok(None);
                }
            }
        }
        Ok(Some(session_project_binding_row_from_model(model)))
    }

    /// Reconcile one Agent's memberships against its authoritative live set.
    ///
    /// Removed Sessions lose their membership, present Sessions adopt/invalidate
    /// by incarnation. Called after a force-refresh projection, which is the
    /// Agent's complete live set for that Agent.
    pub async fn reconcile_session_project_bindings(
        &self,
        agent_id: &str,
        live: &[(String, Option<String>, Option<i64>)],
    ) -> Result<()> {
        let live_ids: std::collections::HashSet<&str> =
            live.iter().map(|(id, _, _)| id.as_str()).collect();
        let existing = session_project_bindings::Entity::find()
            .filter(session_project_bindings::Column::AgentId.eq(agent_id))
            .all(&self.conn)
            .await
            .context("failed to list agent session project bindings")?;
        for row in existing {
            if !live_ids.contains(row.session_id.as_str()) {
                session_project_bindings::Entity::delete_by_id(row.session_id)
                    .exec(&self.conn)
                    .await
                    .context("failed to remove binding for a removed Session")?;
            }
        }
        for (session_id, incarnation_id, created_at) in live {
            self.adopt_or_invalidate_session_project_binding(
                session_id,
                incarnation_id.as_deref(),
                *created_at,
            )
            .await?;
        }
        Ok(())
    }

    // ── Projects (#3021) ──────────────────────────────────────────────

    /// Insert one Project.
    ///
    /// A conflicting `project_id` is an error rather than an overwrite: the
    /// Server mints identities, so a collision means something is wrong and
    /// silently replacing a Project would lose declared state.
    pub async fn insert_project(&self, row: &ProjectRow) -> Result<()> {
        let model = projects::ActiveModel {
            project_id: Set(row.project_id.clone()),
            name: Set(row.name.clone()),
            description: Set(row.description.clone()),
            source_json: Set(encode_optional_project_json(
                row.source.as_ref(),
                "project source",
            )?),
            locations_json: Set(serde_json::to_string(&row.locations)
                .context("failed to encode project locations")?),
            session_defaults_json: Set(encode_optional_project_json(
                row.session_defaults.as_ref(),
                "project session defaults",
            )?),
            image_digest: Set(row.image_digest.clone()),
            created_at: Set(row.created_at),
            updated_at: Set(row.updated_at),
        };
        projects::Entity::insert(model)
            .exec(&self.conn)
            .await
            .context("failed to insert project")?;
        Ok(())
    }

    /// List every Project, oldest first. Identity order breaks timestamp ties.
    pub async fn list_projects(&self) -> Result<Vec<ProjectRow>> {
        let rows = projects::Entity::find()
            .order_by_asc(projects::Column::CreatedAt)
            .order_by_asc(projects::Column::ProjectId)
            .all(&self.conn)
            .await
            .context("failed to list projects")?;
        rows.into_iter().map(project_row_from_model).collect()
    }

    /// Read one Project by identity. `None` when it does not exist.
    pub async fn get_project(&self, project_id: &str) -> Result<Option<ProjectRow>> {
        let row = projects::Entity::find_by_id(project_id.to_owned())
            .one(&self.conn)
            .await
            .context("failed to read project")?;
        row.map(project_row_from_model).transpose()
    }

    /// Replace one Project's mutable fields.
    ///
    /// `row.created_at` is ignored: the stored creation time is preserved, so
    /// an edit never reassigns identity or age. Returns the updated row, or
    /// `None` when the identity does not exist.
    pub async fn update_project(&self, row: &ProjectRow) -> Result<Option<ProjectRow>> {
        let Some(existing) = projects::Entity::find_by_id(row.project_id.clone())
            .one(&self.conn)
            .await
            .context("failed to load project for update")?
        else {
            return Ok(None);
        };
        let mut model: projects::ActiveModel = existing.into();
        model.name = Set(row.name.clone());
        model.description = Set(row.description.clone());
        model.source_json = Set(encode_optional_project_json(
            row.source.as_ref(),
            "project source",
        )?);
        model.locations_json =
            Set(serde_json::to_string(&row.locations)
                .context("failed to encode project locations")?);
        model.session_defaults_json = Set(encode_optional_project_json(
            row.session_defaults.as_ref(),
            "project session defaults",
        )?);
        model.image_digest = Set(row.image_digest.clone());
        model.updated_at = Set(row.updated_at);
        let updated = model
            .update(&self.conn)
            .await
            .context("failed to update project")?;
        Ok(Some(project_row_from_model(updated)?))
    }

    /// Delete one Project by identity. Returns `true` if a row was removed.
    ///
    /// Only this declaration is deleted. Existing Locations are user-owned
    /// directories and EROFS digests are references to globally shared
    /// artifacts; neither is touched here.
    pub async fn delete_project(&self, project_id: &str) -> Result<bool> {
        let txn = self
            .conn
            .begin()
            .await
            .context("failed to begin project deletion")?;
        session_project_bindings::Entity::delete_many()
            .filter(session_project_bindings::Column::ProjectId.eq(project_id))
            .exec(&txn)
            .await
            .context("failed to clear project session bindings")?;
        let res = projects::Entity::delete_by_id(project_id.to_owned())
            .exec(&txn)
            .await
            .context("failed to delete project")?;
        txn.commit()
            .await
            .context("failed to commit project deletion")?;
        Ok(res.rows_affected > 0)
    }
}

fn session_project_binding_row_from_model(
    model: session_project_bindings::Model,
) -> SessionProjectBindingRow {
    SessionProjectBindingRow {
        session_id: model.session_id,
        agent_id: model.agent_id,
        project_id: model.project_id,
        incarnation_id: model.incarnation_id,
        agent_created_at: model.agent_created_at,
        revision: u64::try_from(model.revision).unwrap_or(0),
        updated_at: model.updated_at,
    }
}

fn encode_optional_project_json<T: serde::Serialize>(
    value: Option<&T>,
    what: &str,
) -> Result<Option<String>> {
    value
        .map(|value| {
            serde_json::to_string(value).with_context(|| format!("failed to encode {what}"))
        })
        .transpose()
}

fn project_row_from_model(model: projects::Model) -> Result<ProjectRow> {
    let project_id = model.project_id;
    let source = model
        .source_json
        .as_deref()
        .map(|json| {
            serde_json::from_str(json)
                .with_context(|| format!("project {project_id} has an undecodable source"))
        })
        .transpose()?;
    let locations = serde_json::from_str(&model.locations_json)
        .with_context(|| format!("project {project_id} has undecodable locations"))?;
    let session_defaults = model
        .session_defaults_json
        .as_deref()
        .map(|json| {
            serde_json::from_str(json)
                .with_context(|| format!("project {project_id} has undecodable session defaults"))
        })
        .transpose()?;
    Ok(ProjectRow {
        project_id,
        name: model.name,
        description: model.description,
        source,
        locations,
        session_defaults,
        image_digest: model.image_digest,
        created_at: model.created_at,
        updated_at: model.updated_at,
    })
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

/// Build the ActiveModel for a Session write. One owner for the column
/// mapping so a single-row upsert and a transactional replacement can never
/// persist different fields.
fn session_active_model(
    session: &crate::registry::session::SessionInfo,
    status: &str,
    now: i64,
) -> sessions::ActiveModel {
    sessions::ActiveModel {
        session_id: Set(session.session_id.clone()),
        agent_id: Set(session.agent_id.clone()),
        session_name: Set(session.session_name.clone()),
        created_at: Set(session.created_at.timestamp()),
        last_activity: Set(now),
        status: Set(status.to_owned()),
        window_count: Set(i32::try_from(session.window_count).unwrap_or(0)),
        attached_clients: Set(i32::try_from(session.attached_clients).unwrap_or(0)),
        metadata: Set(Some(String::new())),
        instance_id: Set(session.instance_id.clone()),
    }
}

/// Upsert a Session on its primary key, overwriting every mutable field.
fn session_upsert_columns() -> OnConflict {
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
            sessions::Column::InstanceId,
        ])
        .to_owned()
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
        instance_id: m.instance_id,
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

fn session_env_binding_row_from_model(m: session_env_bindings::Model) -> SessionEnvBindingRow {
    SessionEnvBindingRow {
        session_id: m.session_id,
        agent_id: m.agent_id,
        desired_revision: u64::try_from(m.desired_revision).unwrap_or(0),
        profiles_json: m.profiles_json,
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
            foreground_command: None,
            working_dir: None,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
            instance_id: None,
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

        // The Project migration applies to an old database too, and the legacy
        // Session above remains valid alongside it (SC-04).
        let project = project_row("project-123e4567-e89b-42d3-a456-426614174000");
        db.insert_project(&project).await.unwrap();
        assert_eq!(
            db.get_project(&project.project_id).await.unwrap().unwrap(),
            project
        );
        assert_eq!(db.list_all_sessions().await.unwrap().len(), 1);

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

    // ── Projects (#3021) ──────────────────────────────────────────────

    fn project_row(id: &str) -> ProjectRow {
        ProjectRow {
            project_id: id.to_owned(),
            name: "Nession".to_owned(),
            description: Some("work".to_owned()),
            source: Some(ProjectSource {
                repository_url: "https://github.com/BestNathan/nession.git".to_owned(),
                reference: "main".to_owned(),
            }),
            locations: vec![
                ProjectLocation {
                    agent_id: "agent-a".to_owned(),
                    path: "/srv/nession".to_owned(),
                },
                ProjectLocation {
                    agent_id: "offline-agent".to_owned(),
                    path: "/srv/nession-two".to_owned(),
                },
            ],
            session_defaults: Some(ProjectSessionDefaults {
                shell: Some("/bin/zsh".to_owned()),
                env_profile_ids: vec!["dev".to_owned(), "prod".to_owned()],
                sandbox_policy_ref: None,
            }),
            image_digest: Some(format!("sha256:{}", "a".repeat(64))),
            created_at: 100,
            updated_at: 100,
        }
    }

    #[tokio::test]
    async fn project_crud() {
        let db = new_db().await;
        assert!(db.list_projects().await.unwrap().is_empty());
        assert!(db
            .get_project("project-123e4567-e89b-42d3-a456-426614174000")
            .await
            .unwrap()
            .is_none());

        let row = project_row("project-123e4567-e89b-42d3-a456-426614174000");
        db.insert_project(&row).await.unwrap();

        let projects = db.list_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0], row);

        let read = db.get_project(&row.project_id).await.unwrap().unwrap();
        assert_eq!(read, row);

        db.delete_project(&row.project_id).await.unwrap();
        assert!(db.list_projects().await.unwrap().is_empty());
        assert!(!db.delete_project(&row.project_id).await.unwrap());
    }

    #[tokio::test]
    async fn project_update_preserves_created_at_and_identity() {
        let db = new_db().await;
        let row = project_row("project-123e4567-e89b-42d3-a456-426614174000");
        db.insert_project(&row).await.unwrap();

        let mut replacement = row.clone();
        replacement.name = "Nession renamed".to_owned();
        replacement.source = None;
        replacement.locations = Vec::new();
        replacement.image_digest = None;
        // The DAO ignores this value and keeps the stored creation time.
        replacement.created_at = 0;
        replacement.updated_at = 200;

        let updated = db
            .update_project(&replacement)
            .await
            .unwrap()
            .expect("the Project exists");
        assert_eq!(updated.project_id, row.project_id);
        assert_eq!(updated.created_at, 100);
        assert_eq!(updated.updated_at, 200);
        assert_eq!(updated.name, "Nession renamed");
        assert!(updated.source.is_none());
        assert!(updated.locations.is_empty());
        assert!(updated.image_digest.is_none());

        let missing = db
            .update_project(&project_row("project-00000000-0000-4000-8000-000000000000"))
            .await
            .unwrap();
        assert!(missing.is_none());
    }

    #[tokio::test]
    async fn project_insert_refuses_a_duplicate_identity() {
        let db = new_db().await;
        let row = project_row("project-123e4567-e89b-42d3-a456-426614174000");
        db.insert_project(&row).await.unwrap();
        assert!(
            db.insert_project(&row).await.is_err(),
            "a Project identity is minted once and never silently reused"
        );
    }

    /// SC-04: restart restores Project identities and references, while a
    /// legacy Session (which has no project association) remains valid.
    #[tokio::test]
    async fn project_state_survives_restart_without_reassigning_identity() {
        let path = format!("/tmp/nession_test_projects_{}.db", uuid::Uuid::new_v4());
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000".to_owned();
        let image_digest = format!("sha256:{}", "b".repeat(64));

        {
            let db = Database::new(&path).await.unwrap();
            let mut row = project_row(&project_id);
            row.image_digest = Some(image_digest.clone());
            db.insert_project(&row).await.unwrap();
            db.insert_session(
                &sess_info("legacy-session", SessionStatus::Active),
                "active",
            )
            .await
            .unwrap();
        }

        {
            let db = Database::new(&path).await.unwrap();
            let project = db.get_project(&project_id).await.unwrap().unwrap();
            assert_eq!(project.project_id, project_id);
            assert_eq!(project.source.as_ref().unwrap().reference, "main");
            assert_eq!(project.locations.len(), 2);
            assert_eq!(project.image_digest.as_deref(), Some(image_digest.as_str()));

            let sessions = db.list_all_sessions().await.unwrap();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].session_id, "legacy-session");
        }

        std::fs::remove_file(&path).ok();
        std::fs::remove_file(format!("{path}-wal")).ok();
        std::fs::remove_file(format!("{path}-shm")).ok();
    }

    // ── Session Project Bindings (#3082) ─────────────────────────────

    fn binding_row(
        session_id: &str,
        project_id: &str,
        agent_created_at: i64,
    ) -> SessionProjectBindingRow {
        SessionProjectBindingRow {
            session_id: session_id.to_owned(),
            agent_id: "a1".to_owned(),
            project_id: project_id.to_owned(),
            incarnation_id: String::new(),
            agent_created_at,
            revision: 1,
            updated_at: chrono::Utc::now().timestamp(),
        }
    }

    #[tokio::test]
    async fn session_project_binding_round_trips_across_restart() {
        let path = format!("/tmp/nession_test_binding_{}.db", uuid::Uuid::new_v4());
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000";
        let binding = binding_row("a1:sess1", project_id, 1_700_000_000);

        {
            let db = Database::new(&path).await.unwrap();
            db.insert_project(&project_row(project_id)).await.unwrap();
            db.insert_session(&sess_info("a1:sess1", SessionStatus::Active), "active")
                .await
                .unwrap();
            db.upsert_session_project_binding(&binding).await.unwrap();
        }
        {
            let db = Database::new(&path).await.unwrap();
            let read = db
                .get_session_project_binding("a1:sess1")
                .await
                .unwrap()
                .expect("the membership survives restart");
            assert_eq!(read, binding);
            assert_eq!(
                db.list_session_project_bindings().await.unwrap(),
                vec![binding]
            );
        }

        std::fs::remove_file(&path).ok();
        std::fs::remove_file(format!("{path}-wal")).ok();
        std::fs::remove_file(format!("{path}-shm")).ok();
    }

    #[tokio::test]
    async fn pending_binding_adopts_the_first_report_and_invalidates_a_reused_name() {
        let db = new_db().await;
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000";
        db.insert_project(&project_row(project_id)).await.unwrap();
        db.insert_session(&sess_info("a1:sess1", SessionStatus::Active), "active")
            .await
            .unwrap();
        db.upsert_session_project_binding(&binding_row("a1:sess1", project_id, 0))
            .await
            .unwrap();

        let adopted = db
            .adopt_or_invalidate_session_project_binding(
                "a1:sess1",
                Some("instance-1"),
                Some(1_700_000_001),
            )
            .await
            .unwrap()
            .expect("pending membership is adopted");
        assert_eq!(adopted.incarnation_id, "instance-1");
        assert_eq!(adopted.agent_created_at, 1_700_000_001);

        let same = db
            .adopt_or_invalidate_session_project_binding(
                "a1:sess1",
                Some("instance-1"),
                Some(1_700_000_001),
            )
            .await
            .unwrap()
            .expect("the same incarnation keeps membership");
        assert_eq!(same.project_id, project_id);

        assert!(db
            .adopt_or_invalidate_session_project_binding(
                "a1:sess1",
                Some("instance-2"),
                Some(1_700_000_999),
            )
            .await
            .unwrap()
            .is_none());
        assert!(
            db.get_session_project_binding("a1:sess1")
                .await
                .unwrap()
                .is_none(),
            "a reused name must not resurrect the previous Project"
        );
    }

    #[tokio::test]
    async fn project_delete_clears_bindings_but_preserves_sessions() {
        let db = new_db().await;
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000";
        db.insert_project(&project_row(project_id)).await.unwrap();
        db.insert_session(&sess_info("a1:sess1", SessionStatus::Active), "active")
            .await
            .unwrap();
        db.upsert_session_project_binding(&binding_row("a1:sess1", project_id, 10))
            .await
            .unwrap();

        assert!(db.delete_project(project_id).await.unwrap());
        assert!(db
            .get_session_project_binding("a1:sess1")
            .await
            .unwrap()
            .is_none());
        assert!(
            db.get_session("a1:sess1").await.unwrap().is_some(),
            "Project deletion never cascades to a Session"
        );
    }

    #[tokio::test]
    async fn session_delete_clears_its_binding() {
        let db = new_db().await;
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000";
        db.insert_project(&project_row(project_id)).await.unwrap();
        db.insert_session(&sess_info("a1:sess1", SessionStatus::Active), "active")
            .await
            .unwrap();
        db.upsert_session_project_binding(&binding_row("a1:sess1", project_id, 10))
            .await
            .unwrap();

        db.delete_session("a1:sess1").await.unwrap();
        assert!(db
            .get_session_project_binding("a1:sess1")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn explicit_agent_deletion_clears_memberships() {
        let db = new_db().await;
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000";
        db.insert_project(&project_row(project_id)).await.unwrap();
        db.insert_session(&sess_info("a1:s1", SessionStatus::Active), "active")
            .await
            .unwrap();
        db.upsert_session_project_binding(&binding_row("a1:s1", project_id, 10))
            .await
            .unwrap();

        db.delete_sessions_and_project_bindings_by_agent("a1")
            .await
            .unwrap();
        assert!(db
            .get_session_project_binding("a1:s1")
            .await
            .unwrap()
            .is_none());
        assert!(db.get_session("a1:s1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn force_refresh_reconciliation_drops_removed_sessions_only() {
        let db = new_db().await;
        let project_id = "project-123e4567-e89b-42d3-a456-426614174000";
        db.insert_project(&project_row(project_id)).await.unwrap();
        for id in ["a1:live", "a1:gone"] {
            db.insert_session(&sess_info(id, SessionStatus::Active), "active")
                .await
                .unwrap();
            db.upsert_session_project_binding(&binding_row(id, project_id, 0))
                .await
                .unwrap();
        }

        db.reconcile_session_project_bindings(
            "a1",
            &[(
                "a1:live".to_owned(),
                Some("instance-live".to_owned()),
                Some(1_700_000_001),
            )],
        )
        .await
        .unwrap();
        let live = db
            .get_session_project_binding("a1:live")
            .await
            .unwrap()
            .expect("present incarnation keeps its membership");
        assert_eq!(live.incarnation_id, "instance-live");
        assert_eq!(live.agent_created_at, 1_700_000_001);
        assert!(db
            .get_session_project_binding("a1:gone")
            .await
            .unwrap()
            .is_none());
    }
}
