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
                metadata TEXT
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
            CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);"
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn insert_agent(
        &self,
        agent_id: &str,
        hostname: &str,
        ip_address: &str,
        port: u16,
        auth_token_hash: &str,
        metadata: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let now = chrono::Utc::now().timestamp();

        conn.execute(
            "INSERT OR REPLACE INTO agents (agent_id, hostname, ip_address, port, registered_at, last_heartbeat, status, auth_token_hash, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'online', ?6, ?7)",
            rusqlite::params![agent_id, hostname, ip_address, port, now, auth_token_hash, metadata],
        )?;

        Ok(())
    }

    pub async fn list_agents(&self) -> Result<Vec<AgentRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT agent_id, hostname, ip_address, port, registered_at, last_heartbeat, status, auth_token_hash, metadata FROM agents"
        )?;

        let agents = stmt.query_map([], |row| {
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
            })
        })?.collect::<Result<Vec<_>>>()?;

        Ok(agents)
    }
}
