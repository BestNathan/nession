pub mod schema;

use rusqlite::{Connection, Result};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct Database {
    conn: Arc<Mutex<Connection>>,
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

impl Database {
    pub async fn new(db_path: &str) -> Result<Self> {
        let conn = Connection::open(db_path)?;

        // Create tables
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                hostname TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                port INTEGER NOT NULL,
                registered_at INTEGER NOT NULL,
                last_heartbeat INTEGER NOT NULL,
                status TEXT NOT NULL,
                auth_token_hash TEXT NOT NULL,
                metadata TEXT,
                connect_url TEXT,
                addresses TEXT
            );

            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                session_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_activity INTEGER NOT NULL,
                status TEXT NOT NULL,
                window_count INTEGER NOT NULL,
                attached_clients INTEGER NOT NULL,
                metadata TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
            CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);",
        )?;

        // Lightweight migrations for DBs created before these columns existed.
        // There is no migration runner; `ADD COLUMN` on an existing column
        // errors, so we add them best-effort and ignore the duplicate error.
        Self::add_column_if_missing(&conn, "agents", "connect_url", "TEXT");
        Self::add_column_if_missing(&conn, "agents", "addresses", "TEXT");

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Add a column to a table, ignoring the error SQLite raises when the
    /// column already exists. Used for schema migrations on existing DBs.
    fn add_column_if_missing(conn: &Connection, table: &str, column: &str, col_type: &str) {
        let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {col_type}");
        match conn.execute(&sql, []) {
            Ok(_) => tracing::info!("Migrated {table}: added column {column}"),
            Err(e) => {
                // "duplicate column name" is expected on already-migrated DBs.
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    tracing::warn!("Migration ALTER TABLE {table} ADD {column} failed: {msg}");
                }
            }
        }
    }

    pub async fn insert_agent(&self, agent: AgentInsert<'_>) -> Result<()> {
        let conn = self.conn.lock().await;
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            "INSERT OR REPLACE INTO agents (agent_id, hostname, ip_address, port, registered_at, last_heartbeat, status, auth_token_hash, metadata, connect_url, addresses)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'online', ?6, ?7, ?8, ?9)",
            rusqlite::params![
                agent.agent_id,
                agent.hostname,
                agent.ip_address,
                agent.port,
                now,
                agent.auth_token_hash,
                agent.metadata,
                agent.connect_url,
                agent.addresses
            ],
        )?;

        Ok(())
    }

    pub async fn list_agents(&self) -> Result<Vec<AgentRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT agent_id, hostname, ip_address, port, registered_at, last_heartbeat, status, auth_token_hash, metadata, connect_url, addresses FROM agents"
        )?;

        let agents = stmt
            .query_map([], |row| {
                Ok(AgentRow {
                    agent_id: row.get(0)?,
                    hostname: row.get(1)?,
                    ip_address: row.get(2)?,
                    port: row.get(3)?,
                    registered_at: row.get(4)?,
                    last_heartbeat: row.get(5)?,
                    status: row.get(6)?,
                    auth_token_hash: row.get(7)?,
                    metadata: row.get(8)?,
                    connect_url: row.get(9)?,
                    addresses: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(agents)
    }

    pub async fn insert_session(
        &self,
        session: &crate::registry::session::SessionInfo,
        status: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            "INSERT OR REPLACE INTO sessions (session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '')",
            rusqlite::params![
                session.session_id,
                session.agent_id,
                session.session_name,
                session.created_at.timestamp(),
                now,
                status,
                session.window_count,
                session.attached_clients,
            ],
        )?;

        Ok(())
    }

    pub async fn update_session_status(&self, session_id: &str, status: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE sessions SET status = ?1, last_activity = ?2 WHERE session_id = ?3",
            rusqlite::params![status, chrono::Utc::now().timestamp(), session_id],
        )?;
        Ok(())
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            rusqlite::params![session_id],
        )?;
        Ok(())
    }

    pub async fn delete_sessions_by_agent(&self, agent_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM sessions WHERE agent_id = ?1",
            rusqlite::params![agent_id],
        )?;
        Ok(())
    }

    pub async fn list_all_sessions(&self) -> Result<Vec<SessionRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata FROM sessions"
        )?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(SessionRow {
                    session_id: row.get(0)?,
                    agent_id: row.get(1)?,
                    session_name: row.get(2)?,
                    created_at: row.get(3)?,
                    last_activity: row.get(4)?,
                    status: row.get(5)?,
                    window_count: row.get(6)?,
                    attached_clients: row.get(7)?,
                    metadata: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(sessions)
    }

    pub async fn list_sessions_older_than(&self, duration_secs: i64) -> Result<Vec<SessionRow>> {
        let conn = self.conn.lock().await;
        let cutoff = chrono::Utc::now().timestamp() - duration_secs;
        let mut stmt = conn.prepare(
            "SELECT session_id, agent_id, session_name, created_at, last_activity, status, window_count, attached_clients, metadata FROM sessions WHERE last_activity < ?1 AND status = 'recovering'"
        )?;

        let sessions = stmt
            .query_map([cutoff], |row| {
                Ok(SessionRow {
                    session_id: row.get(0)?,
                    agent_id: row.get(1)?,
                    session_name: row.get(2)?,
                    created_at: row.get(3)?,
                    last_activity: row.get(4)?,
                    status: row.get(5)?,
                    window_count: row.get(6)?,
                    attached_clients: row.get(7)?,
                    metadata: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(sessions)
    }
}
