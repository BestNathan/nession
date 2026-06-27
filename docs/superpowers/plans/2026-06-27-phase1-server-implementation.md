# Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the central server (control-plane) that coordinates agents, manages session registry, and brokers connections.

**Architecture:** Rust async server with WebSocket (WSS), SQLite database, agent/session registries. Handles agent registration, heartbeats, session discovery, and connection brokering.

**Tech Stack:** Rust, tokio, tokio-tungstenite, rustls, serde_json, rusqlite, tracing

---

## Task 1: Configuration and Error Types

**Files:**
- Create: `crates/nession-common/src/config.rs`
- Create: `crates/nession-common/src/error.rs`
- Test: `crates/nession-common/tests/config_test.rs`

- [ ] **Step 1: Write failing test for server config**

Create `crates/nession-common/tests/config_test.rs`:
```rust
use nession_common::config::ServerConfig;

#[test]
fn test_server_config_parsing() {
    let toml_str = r#"
        listen_address = "0.0.0.0:8443"
        tls_cert_path = "/path/to/cert.pem"
        tls_key_path = "/path/to/key.pem"
        auth_token = "secret_token_123"
        heartbeat_timeout_secs = 30
        db_path = "./nession-server.db"
    "#;
    
    let config: ServerConfig = toml::from_str(toml_str).unwrap();
    assert_eq!(config.listen_address, "0.0.0.0:8443");
    assert_eq!(config.heartbeat_timeout_secs, 30);
    assert_eq!(config.db_path, "./nession-server.db");
}

#[test]
fn test_server_config_defaults() {
    let toml_str = r#"
        listen_address = "0.0.0.0:8443"
        tls_cert_path = "/path/to/cert.pem"
        tls_key_path = "/path/to/key.pem"
        auth_token = "secret_token_123"
    "#;
    
    let config: ServerConfig = toml::from_str(toml_str).unwrap();
    assert_eq!(config.heartbeat_timeout_secs, 30); // default
    assert_eq!(config.db_path, "./nession-server.db"); // default
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-common --test config_test`
Expected: FAIL with "module `config` not found"

- [ ] **Step 3: Implement ServerConfig**

Create `crates/nession-common/src/config.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub listen_address: String,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub auth_token: String,
    #[serde(default = "default_heartbeat_timeout")]
    pub heartbeat_timeout_secs: u64,
    #[serde(default = "default_db_path")]
    pub db_path: String,
}

fn default_heartbeat_timeout() -> u64 {
    30
}

fn default_db_path() -> String {
    "./nession-server.db".to_string()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p nession-common --test config_test`
Expected: PASS

- [ ] **Step 5: Implement error types**

Create `crates/nession-common/src/error.rs`:
```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum NessionError {
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    
    #[error("Agent not found: {0}")]
    AgentNotFound(String),
    
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    
    #[error("Invalid message format: {0}")]
    InvalidMessage(String),
    
    #[error("Database error: {0}")]
    DatabaseError(String),
    
    #[error("WebSocket error: {0}")]
    WebSocketError(String),
    
    #[error("Configuration error: {0}")]
    ConfigError(String),
    
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, NessionError>;
```

- [ ] **Step 6: Update lib.rs exports**

Update `crates/nession-common/src/lib.rs`:
```rust
pub mod protocol;
pub mod config;
pub mod error;

pub use error::{NessionError, Result};
```

- [ ] **Step 7: Run all nession-common tests**

Run: `cargo test -p nession-common`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add crates/nession-common/src/config.rs crates/nession-common/src/error.rs crates/nession-common/src/lib.rs crates/nession-common/tests/config_test.rs
git commit -m "feat: add server configuration and error types"
```

---

## Task 2: Agent Registry

**Files:**
- Create: `crates/nession-server/src/registry/agent.rs`
- Test: `crates/nession-server/tests/agent_registry_test.rs`

- [ ] **Step 1: Write failing test for agent registration**

Create `crates/nession-server/tests/agent_registry_test.rs`:
```rust
use nession_server::registry::agent::{AgentRegistry, AgentInfo, AgentStatus};
use nession_common::protocol::AgentMetadata;
use chrono::Utc;

#[tokio::test]
async fn test_agent_registration() {
    let registry = AgentRegistry::new(30);
    
    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Ubuntu 22.04".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };
    
    registry.register(agent.clone()).await;
    
    let retrieved = registry.get("agent_123").await;
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().hostname, "dev-server");
}

#[tokio::test]
async fn test_agent_heartbeat_update() {
    let registry = AgentRegistry::new(30);
    
    let agent = AgentInfo {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
        registered_at: Utc::now(),
        last_heartbeat: Utc::now(),
        status: AgentStatus::Online,
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Ubuntu 22.04".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        session_count: 0,
        active_sessions: 0,
    };
    
    registry.register(agent).await;
    
    // Update heartbeat
    registry.update_heartbeat("agent_123", 5, 3).await;
    
    let updated = registry.get("agent_123").await.unwrap();
    assert_eq!(updated.session_count, 5);
    assert_eq!(updated.active_sessions, 3);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-server --test agent_registry_test`
Expected: FAIL with "module `registry` not found"

- [ ] **Step 3: Implement AgentRegistry**

Create `crates/nession-server/src/registry/agent.rs`:
```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};
use nession_common::protocol::AgentMetadata;

#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub registered_at: DateTime<Utc>,
    pub last_heartbeat: DateTime<Utc>,
    pub status: AgentStatus,
    pub metadata: AgentMetadata,
    pub session_count: u32,
    pub active_sessions: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentStatus {
    Online,
    Offline,
    Degraded,
}

pub struct AgentRegistry {
    agents: Arc<RwLock<HashMap<String, AgentInfo>>>,
    heartbeat_timeout_secs: u64,
}

impl AgentRegistry {
    pub fn new(heartbeat_timeout_secs: u64) -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_timeout_secs,
        }
    }
    
    pub async fn register(&self, info: AgentInfo) {
        let mut agents = self.agents.write().await;
        agents.insert(info.agent_id.clone(), info);
    }
    
    pub async fn update_heartbeat(&self, agent_id: &str, session_count: u32, active_sessions: u32) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.last_heartbeat = Utc::now();
            agent.status = AgentStatus::Online;
            agent.session_count = session_count;
            agent.active_sessions = active_sessions;
        }
    }
    
    pub async fn get(&self, agent_id: &str) -> Option<AgentInfo> {
        let agents = self.agents.read().await;
        agents.get(agent_id).cloned()
    }
    
    pub async fn list(&self) -> Vec<AgentInfo> {
        let agents = self.agents.read().await;
        agents.values().cloned().collect()
    }
    
    pub async fn check_offline_agents(&self) -> Vec<String> {
        let mut agents = self.agents.write().await;
        let now = Utc::now();
        let mut offline = vec![];
        
        for (agent_id, agent) in agents.iter_mut() {
            if agent.status == AgentStatus::Online {
                let elapsed = (now - agent.last_heartbeat).num_seconds() as u64;
                if elapsed > self.heartbeat_timeout_secs {
                    agent.status = AgentStatus::Offline;
                    offline.push(agent_id.clone());
                }
            }
        }
        
        offline
    }
    
    pub async fn unregister(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        agents.remove(agent_id);
    }
}
```

- [ ] **Step 4: Create registry mod.rs**

Create `crates/nession-server/src/registry/mod.rs`:
```rust
pub mod agent;
pub mod session;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p nession-server --test agent_registry_test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/nession-server/src/registry/ crates/nession-server/tests/agent_registry_test.rs
git commit -m "feat: implement agent registry with heartbeat tracking"
```

---

## Task 3: Session Registry

**Files:**
- Create: `crates/nession-server/src/registry/session.rs`
- Test: `crates/nession-server/tests/session_registry_test.rs`

- [ ] **Step 1: Write failing test for session registry**

Create `crates/nession-server/tests/session_registry_test.rs`:
```rust
use nession_server::registry::session::{SessionRegistry, SessionInfo, SessionStatus};
use chrono::Utc;

#[tokio::test]
async fn test_session_update() {
    let registry = SessionRegistry::new();
    
    let session = SessionInfo {
        session_id: "agent_123:dev-work".to_string(),
        agent_id: "agent_123".to_string(),
        session_name: "dev-work".to_string(),
        status: SessionStatus::Active,
        window_count: 3,
        attached_clients: 1,
        last_activity: Utc::now(),
    };
    
    registry.update_session(session.clone()).await;
    
    let retrieved = registry.get("agent_123:dev-work").await;
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().session_name, "dev-work");
}

#[tokio::test]
async fn test_list_sessions_by_agent() {
    let registry = SessionRegistry::new();
    
    let session1 = SessionInfo {
        session_id: "agent_123:session1".to_string(),
        agent_id: "agent_123".to_string(),
        session_name: "session1".to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        last_activity: Utc::now(),
    };
    
    let session2 = SessionInfo {
        session_id: "agent_456:session2".to_string(),
        agent_id: "agent_456".to_string(),
        session_name: "session2".to_string(),
        status: SessionStatus::Active,
        window_count: 1,
        attached_clients: 0,
        last_activity: Utc::now(),
    };
    
    registry.update_session(session1).await;
    registry.update_session(session2).await;
    
    let agent1_sessions = registry.list_by_agent("agent_123").await;
    assert_eq!(agent1_sessions.len(), 1);
    assert_eq!(agent1_sessions[0].session_name, "session1");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-server --test session_registry_test`
Expected: FAIL with "module `session` not found"

- [ ] **Step 3: Implement SessionRegistry**

Create `crates/nession-server/src/registry/session.rs`:
```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
    pub last_activity: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Detached,
    Zombie,
}

pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionInfo>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub async fn update_session(&self, session: SessionInfo) {
        let mut sessions = self.sessions.write().await;
        sessions.insert(session.session_id.clone(), session);
    }
    
    pub async fn get(&self, session_id: &str) -> Option<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }
    
    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }
    
    pub async fn list_by_agent(&self, agent_id: &str) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.values()
            .filter(|s| s.agent_id == agent_id)
            .cloned()
            .collect()
    }
    
    pub async fn remove(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }
    
    pub async fn remove_by_agent(&self, agent_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, s| s.agent_id != agent_id);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p nession-server --test session_registry_test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/nession-server/src/registry/session.rs crates/nession-server/tests/session_registry_test.rs
git commit -m "feat: implement session registry with agent filtering"
```

---

## Task 4: SQLite Database

**Files:**
- Create: `crates/nession-server/src/db/schema.rs`
- Test: `crates/nession-server/tests/db_test.rs`

- [ ] **Step 1: Write failing test for database initialization**

Create `crates/nession-server/tests/db_test.rs`:
```rust
use nession_server::db::Database;
use tempfile::NamedTempFile;

#[tokio::test]
async fn test_database_initialization() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path().to_str().unwrap();
    
    let db = Database::new(db_path).await.unwrap();
    
    // Verify tables exist
    let agents = db.list_agents().await.unwrap();
    assert_eq!(agents.len(), 0);
}

#[tokio::test]
async fn test_agent_persistence() {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path().to_str().unwrap();
    
    let db = Database::new(db_path).await.unwrap();
    
    // Insert agent
    db.insert_agent(
        "agent_123",
        "dev-server",
        "192.168.1.10",
        8080,
        "hashed_token",
        r#"{"tmux_version": "3.3a"}"#
    ).await.unwrap();
    
    // Retrieve agent
    let agents = db.list_agents().await.unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].agent_id, "agent_123");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-server --test db_test`
Expected: FAIL with "module `db` not found"

- [ ] **Step 3: Implement Database**

Create `crates/nession-server/src/db/mod.rs`:
```rust
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
```

- [ ] **Step 4: Add tempfile dependency**

Add to `crates/nession-server/Cargo.toml` under `[dev-dependencies]`:
```toml
[dev-dependencies]
tempfile = "3.8"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p nession-server --test db_test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/nession-server/src/db/ crates/nession-server/tests/db_test.rs crates/nession-server/Cargo.toml
git commit -m "feat: implement SQLite database with agent/session tables"
```

---

*Note: This plan continues with Task 5 (WebSocket Server), Task 6 (Connection Broker), Task 7 (Server Main Binary), and Task 8 (Integration Tests). Due to length, I'm providing the structure and first 4 tasks as a template.*

**Would you like me to:**
1. **Continue writing all remaining server tasks** (Tasks 5-8)
2. **Move to Plan 2 (Agent)** and write that plan
3. **Start implementing** with current tasks and iterate

Which approach do you prefer?
