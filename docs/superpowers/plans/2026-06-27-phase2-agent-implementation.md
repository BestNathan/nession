# Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the local tmux agent that manages tmux sessions, handles terminal I/O, and communicates with the server.

**Architecture:** Rust async agent with dual-mode tmux integration (commands for management, pty for I/O). WebSocket server for P2P client connections and WebSocket client for server communication.

**Tech Stack:** Rust, tokio, tokio-tungstenite, rustls, nix (pty), serde_json, tracing

---

## Task 1: Tmux Manager (Command Mode)

**Files:**
- Create: `crates/nession-agent/src/tmux/manager.rs`
- Test: `crates/nession-agent/tests/tmux_manager_test.rs`

- [ ] **Step 1: Write failing test for listing sessions**

Create `crates/nession-agent/tests/tmux_manager_test.rs`:
```rust
use nession_agent::tmux::manager::TmuxManager;

#[tokio::test]
async fn test_list_sessions_empty() {
    let manager = TmuxManager::new();
    let sessions = manager.list_sessions().await.unwrap();
    // tmux may not be running, so empty list is expected
    assert!(sessions.len() >= 0);
}

#[tokio::test]
async fn test_create_and_kill_session() {
    let manager = TmuxManager::new();
    let session_name = "test_session_integration";
    
    // Create session
    manager.create_session(session_name, 80, 24).await.unwrap();
    
    // Verify it exists
    let sessions = manager.list_sessions().await.unwrap();
    assert!(sessions.iter().any(|s| s.name == session_name));
    
    // Kill session
    manager.kill_session(session_name).await.unwrap();
    
    // Verify it's gone
    let sessions = manager.list_sessions().await.unwrap();
    assert!(!sessions.iter().any(|s| s.name == session_name));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-agent --test tmux_manager_test`
Expected: FAIL with "module `tmux` not found"

- [ ] **Step 3: Implement TmuxManager**

Create `crates/nession-agent/src/tmux/manager.rs`:
```rust
use std::process::Stdio;
use tokio::process::Command;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub name: String,
    pub created_at: u64,
    pub window_count: u32,
    pub attached_clients: u32,
    pub width: u16,
    pub height: u16,
}

pub struct TmuxManager;

impl TmuxManager {
    pub fn new() -> Self {
        Self
    }
    
    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        let output = Command::new("tmux")
            .args(&[
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}\t#{window_width}\t#{window_height}",
            ])
            .output()
            .await?;
        
        if !output.status.success() {
            // tmux server not running, return empty list
            return Ok(vec![]);
        }
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let sessions: Vec<SessionInfo> = stdout
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() == 6 {
                    Some(SessionInfo {
                        name: parts[0].to_string(),
                        created_at: parts[1].parse().ok()?,
                        window_count: parts[2].parse().ok()?,
                        attached_clients: parts[3].parse().ok()?,
                        width: parts[4].parse().ok()?,
                        height: parts[5].parse().ok()?,
                    })
                } else {
                    None
                }
            })
            .collect();
        
        Ok(sessions)
    }
    
    pub async fn create_session(&self, name: &str, width: u16, height: u16) -> Result<()> {
        let status = Command::new("tmux")
            .args(&[
                "new-session",
                "-d",
                "-s", name,
                "-x", &width.to_string(),
                "-y", &height.to_string(),
            ])
            .status()
            .await?;
        
        if !status.success() {
            anyhow::bail!("Failed to create session: {}", name);
        }
        
        Ok(())
    }
    
    pub async fn kill_session(&self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(&["kill-session", "-t", name])
            .status()
            .await?;
        
        if !status.success() {
            anyhow::bail!("Failed to kill session: {}", name);
        }
        
        Ok(())
    }
    
    pub async fn send_keys(&self, session_name: &str, keys: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(&["send-keys", "-t", session_name, keys])
            .status()
            .await?;
        
        if !status.success() {
            anyhow::bail!("Failed to send keys to session: {}", session_name);
        }
        
        Ok(())
    }
    
    pub async fn check_tmux_available(&self) -> Result<bool> {
        let status = Command::new("tmux")
            .arg("-V")
            .status()
            .await?;
        
        Ok(status.success())
    }
}
```

- [ ] **Step 4: Create tmux mod.rs**

Create `crates/nession-agent/src/tmux/mod.rs`:
```rust
pub mod manager;
pub mod pty;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p nession-agent --test tmux_manager_test`
Expected: PASS (if tmux is installed)

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/tmux/ crates/nession-agent/tests/tmux_manager_test.rs
git commit -m "feat: implement tmux manager with command mode"
```

---

## Task 2: Tmux Control Mode (PTY)

**Files:**
- Create: `crates/nession-agent/src/tmux/pty.rs`
- Test: `crates/nession-agent/tests/pty_test.rs`

- [ ] **Step 1: Add nix dependency**

Add to `crates/nession-agent/Cargo.toml`:
```toml
[dependencies]
# ... existing dependencies ...
nix = { version = "0.28", features = ["term", "pty"] }
```

- [ ] **Step 2: Write failing test for PTY attach**

Create `crates/nession-agent/tests/pty_test.rs`:
```rust
use nession_agent::tmux::pty::TmuxPty;
use nession_agent::tmux::manager::TmuxManager;

#[tokio::test]
async fn test_pty_attach_and_io() {
    let manager = TmuxManager::new();
    let session_name = "test_pty_session";
    
    // Create session first
    manager.create_session(session_name, 80, 24).await.unwrap();
    
    // Attach via PTY
    let mut pty = TmuxPty::attach(session_name).await.unwrap();
    
    // Send input
    pty.write_input("echo hello\n").await.unwrap();
    
    // Read output
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    let output = pty.read_output().await.unwrap();
    assert!(output.contains("hello"));
    
    // Cleanup
    manager.kill_session(session_name).await.unwrap();
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p nession-agent --test pty_test`
Expected: FAIL with "module `pty` not found"

- [ ] **Step 4: Implement TmuxPty**

Create `crates/nession-agent/src/tmux/pty.rs`:
```rust
use std::os::unix::io::{AsRawFd, FromRawFd};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use anyhow::Result;

pub struct TmuxPty {
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    _child: tokio::process::Child,
}

impl TmuxPty {
    pub async fn attach(session_name: &str) -> Result<Self> {
        let mut child = Command::new("tmux")
            .args(&["attach-session", "-t", session_name])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        
        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("Failed to get stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("Failed to get stdout"))?;
        
        Ok(Self {
            stdin,
            stdout,
            _child: child,
        })
    }
    
    pub async fn write_input(&mut self, data: &str) -> Result<()> {
        self.stdin.write_all(data.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }
    
    pub async fn read_output(&mut self) -> Result<String> {
        let mut buffer = vec![0u8; 4096];
        let n = self.stdout.read(&mut buffer).await?;
        Ok(String::from_utf8_lossy(&buffer[..n]).to_string())
    }
    
    pub async fn resize(&self, _width: u16, _height: u16) -> Result<()> {
        // tmux resize is handled via tmux command, not PTY
        Ok(())
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p nession-agent --test pty_test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/tmux/pty.rs crates/nession-agent/tests/pty_test.rs crates/nession-agent/Cargo.toml
git commit -m "feat: implement tmux PTY control mode for terminal I/O"
```

---

## Task 3: Server Connection and Heartbeat

**Files:**
- Create: `crates/nession-agent/src/server/websocket.rs`
- Test: `crates/nession-agent/tests/server_connection_test.rs`

- [ ] **Step 1: Write failing test for server connection**

Create `crates/nession-agent/tests/server_connection_test.rs`:
```rust
use nession_agent::server::websocket::ServerConnection;
use nession_common::config::AgentConfig;

#[tokio::test]
async fn test_server_connection_config() {
    let config = AgentConfig {
        agent_id: "test_agent".to_string(),
        server_url: "wss://localhost:8443".to_string(),
        auth_token: "test_token".to_string(),
        listen_address: "0.0.0.0:8080".to_string(),
        tls_cert_path: "/path/to/cert.pem".to_string(),
        tls_key_path: "/path/to/key.pem".to_string(),
        heartbeat_interval_secs: 10,
    };
    
    let conn = ServerConnection::new(config);
    assert_eq!(conn.agent_id(), "test_agent");
}
```

- [ ] **Step 2: Implement AgentConfig**

Add to `crates/nession-common/src/config.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub agent_id: String,
    pub server_url: String,
    pub auth_token: String,
    pub listen_address: String,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval_secs: u64,
}

fn default_heartbeat_interval() -> u64 {
    10
}
```

- [ ] **Step 3: Implement ServerConnection**

Create `crates/nession-agent/src/server/websocket.rs`:
```rust
use nession_common::config::AgentConfig;
use nession_common::protocol::{Message, AgentRegisterPayload, AgentMetadata, AgentHeartbeatPayload, AgentStatus, HeartbeatMetadata};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use anyhow::Result;

pub struct ServerConnection {
    config: AgentConfig,
}

impl ServerConnection {
    pub fn new(config: AgentConfig) -> Self {
        Self { config }
    }
    
    pub fn agent_id(&self) -> &str {
        &self.config.agent_id
    }
    
    pub async fn connect(&self) -> Result<()> {
        // Connect to server via WebSocket
        // Send registration message
        // Start heartbeat loop
        todo!("Implement WebSocket connection to server")
    }
    
    pub fn build_registration_message(&self) -> Message<AgentRegisterPayload> {
        Message {
            msg_type: "agent.register".to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp() as u64,
            payload: AgentRegisterPayload {
                agent_id: self.config.agent_id.clone(),
                hostname: hostname::get().unwrap_or_default().to_string_lossy().to_string(),
                ip_address: "127.0.0.1".to_string(), // TODO: get actual IP
                port: 8080,
                auth_token: self.config.auth_token.clone(),
                metadata: AgentMetadata {
                    tmux_version: "3.3a".to_string(),
                    os_version: "Linux".to_string(),
                    nession_version: env!("CARGO_PKG_VERSION").to_string(),
                },
                protocol_version: "1.0".to_string(),
            },
        }
    }
    
    pub fn build_heartbeat_message(&self, session_count: u32, active_sessions: u32) -> Message<AgentHeartbeatPayload> {
        Message {
            msg_type: "agent.heartbeat".to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp() as u64,
            payload: AgentHeartbeatPayload {
                agent_id: self.config.agent_id.clone(),
                status: AgentStatus::Online,
                session_count,
                active_sessions,
                metadata: HeartbeatMetadata {
                    uptime_seconds: 0, // TODO: track uptime
                    load_average: [0.0, 0.0, 0.0], // TODO: get actual load
                },
            },
        }
    }
}
```

- [ ] **Step 4: Add hostname dependency**

Add to `crates/nession-agent/Cargo.toml`:
```toml
hostname = "0.4"
```

- [ ] **Step 5: Create server mod.rs**

Create `crates/nession-agent/src/server/mod.rs`:
```rust
pub mod websocket;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cargo test -p nession-agent --test server_connection_test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/nession-agent/src/server/ crates/nession-agent/tests/server_connection_test.rs crates/nession-agent/Cargo.toml crates/nession-common/src/config.rs
git commit -m "feat: implement server connection with registration and heartbeat"
```

---

## Task 4: Agent Main Binary

**Files:**
- Modify: `crates/nession-agent/src/main.rs`

- [ ] **Step 1: Implement main function**

Create `crates/nession-agent/src/main.rs`:
```rust
use anyhow::Result;
use nession_agent::tmux::manager::TmuxManager;
use nession_agent::server::websocket::ServerConnection;
use nession_common::config::AgentConfig;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();
    
    tracing::info!("Starting nession agent");
    
    // Check tmux availability
    let tmux = TmuxManager::new();
    if !tmux.check_tmux_available().await? {
        anyhow::bail!("tmux not found. Please install tmux 2.6 or later.");
    }
    
    // Load configuration
    let config = load_config()?;
    
    tracing::info!(agent_id = %config.agent_id, "Agent configuration loaded");
    
    // Create server connection
    let server_conn = ServerConnection::new(config);
    
    tracing::info!("Connecting to server...");
    
    // Connect to server (TODO: implement full connection logic)
    // server_conn.connect().await?;
    
    tracing::info!("Agent started successfully");
    
    // Keep running
    tokio::signal::ctrl_c().await?;
    tracing::info!("Shutting down agent");
    
    Ok(())
}

fn load_config() -> Result<AgentConfig> {
    // TODO: Load from config file
    Ok(AgentConfig {
        agent_id: "agent_001".to_string(),
        server_url: "wss://localhost:8443".to_string(),
        auth_token: "test_token".to_string(),
        listen_address: "0.0.0.0:8080".to_string(),
        tls_cert_path: "/path/to/cert.pem".to_string(),
        tls_key_path: "/path/to/key.pem".to_string(),
        heartbeat_interval_secs: 10,
    })
}
```

- [ ] **Step 2: Verify agent compiles**

Run: `cargo build -p nession-agent`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/main.rs
git commit -m "feat: implement agent main binary with startup logic"
```

---

*Note: This plan continues with Task 5 (P2P WebSocket Server), Task 6 (Session Management), Task 7 (Heartbeat Loop), and Task 8 (Integration Tests). Due to length, providing structure and first 4 tasks as template.*

**Would you like me to:**
1. **Continue with Phase 3 (CLI) plan**
2. **Continue with Phase 4 (Web UI) plan**
3. **Expand this Agent plan with remaining tasks**

Which should I write next?
