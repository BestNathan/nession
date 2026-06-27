# Architecture: Distributed Tmux Agent System

**Date**: 2026-06-27
**Status**: Draft
**Author**: AI Assistant
**Source**: [Requirements Document](../requirement/2026-06-27-tmux-agent-system-requirement.md)

## Requirements

This architecture implements the distributed tmux agent system as specified in the [requirements document](../requirement/2026-06-27-tmux-agent-system-requirement.md).

**Key Goals:**
- Unified tmux management across multiple machines via control-plane
- Low-latency remote attach (<100ms relay, <50ms P2P)
- Multi-client support (CLI, Web UI, mobile)
- Hybrid connectivity (relay + P2P direct connection)
- Scalability: 100 agents, 1000 sessions per control-plane instance

**Non-Goals:**
- Production-grade high availability (single control-plane instance for v1)
- Public internet deployment (intranet only)
- Multi-tenant isolation (single trusted operator)
- Session recording/playback
- AI framework integrations

## Architecture

The system consists of three main components: **Local Agents** running on tmux hosts, a **Control-Plane** for coordination, and **Clients** (CLI/Web) for user interaction. Communication uses WebSocket with TLS encryption throughout.

```
                                    ┌─────────────────────────────────────┐
                                    │         Control-Plane               │
                                    │  ┌─────────────────────────────┐   │
                                    │  │   WebSocket Server (WSS)    │   │
                                    │  │   - Agent connections       │   │
                                    │  │   - Client connections      │   │
                                    │  │   - Relay forwarding        │   │
                                    │  └─────────────────────────────┘   │
                                    │  ┌─────────────────────────────┐   │
                                    │  │   Agent Registry            │   │
                                    │  │   - Registration            │   │
                                    │  │   - Heartbeat monitoring    │   │
                                    │  │   - Status tracking         │   │
                                    │  └─────────────────────────────┘   │
                                    │  ┌─────────────────────────────┐   │
                                    │  │   Session Registry          │   │
                                    │  │   - Global session view     │   │
                                    │  │   - Metadata storage        │   │
                                    │  └─────────────────────────────┘   │
                                    │  ┌─────────────────────────────┐   │
                                    │  │   Connection Broker         │   │
                                    │  │   - P2P signaling           │   │
                                    │  │   - Relay fallback          │   │
                                    │  └─────────────────────────────┘   │
                                    │  ┌─────────────────────────────┐   │
                                    │  │   SQLite Database           │   │
                                    │  │   - agents table            │   │
                                    │  │   - sessions table          │   │
                                    │  │   - connections table       │   │
                                    │  └─────────────────────────────┘   │
                                    └─────────────────────────────────────┘
                                               ▲              ▲
                                               │              │
                                    ┌──────────┴──────────┐   │
                                    │   WSS Connection    │   │
                                    │   (Heartbeat/Reg)   │   │
                                    └─────────────────────┘   │
                                                              
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  ┌──────────────────┐                           ┌──────────────────┐    │
│  │   Local Agent 1  │                           │   Local Agent 2  │    │
│  │  ┌────────────┐  │                           │  ┌────────────┐  │    │
│  │  │  Tmux      │  │                           │  │  Tmux      │  │    │
│  │  │  Manager   │  │                           │  │  Manager   │  │    │
│  │  └────────────┘  │                           │  └────────────┘  │    │
│  │  ┌────────────┐  │                           │  ┌────────────┐  │    │
│  │  │  Session   │  │                           │  │  Session   │  │    │
│  │  │  Registry  │  │                           │  │  Registry  │  │    │
│  │  └────────────┘  │                           │  └────────────┘  │    │
│  │  ┌────────────┐  │                           │  ┌────────────┐  │    │
│  │  │  WebSocket │  │                           │  │  WebSocket │  │    │
│  │  │  Server    │  │                           │  │  Server    │  │    │
│  │  │  (WSS)     │  │                           │  │  (WSS)     │  │    │
│  │  └────────────┘  │                           │  └────────────┘  │    │
│  │  ┌────────────┐  │                           │  ┌────────────┐  │    │
│  │  │  Heartbeat │  │                           │  │  Heartbeat │  │    │
│  │  │  Sender    │  │                           │  │  Sender    │  │    │
│  │  └────────────┘  │                           │  └────────────┘  │    │
│  └──────────────────┘                           └──────────────────┘    │
│           ▲                                              ▲               │
│           │                                              │               │
│     ┌─────┴─────┐                                  ┌─────┴─────┐        │
│     │  tmux srv │                                  │  tmux srv │        │
│     │ session A │                                  │  session B │        │
│     │ session C │                                  │  session D │        │
│     └───────────┘                                  └───────────┘        │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                   │
│                                                                          │
│  ┌──────────────────┐              ┌──────────────────────────────┐     │
│  │   CLI Client     │              │        Web UI Client         │     │
│  │  ┌────────────┐  │              │  ┌────────────────────────┐  │     │
│  │  │  Terminal  │  │              │  │   React + xterm.js     │  │     │
│  │  │  Interface │  │              │  │   - Session dashboard  │  │     │
│  │  └────────────┘  │              │  │   - Terminal emulator  │  │     │
│  │  ┌────────────┐  │              │  │   - Mobile responsive  │  │     │
│  │  │  WebSocket │  │              │  └────────────────────────┘  │     │
│  │  │  Client    │  │              │  ┌────────────────────────┐  │     │
│  │  └────────────┘  │              │  │   WebSocket Client     │  │     │
│  │  ┌────────────┐  │              │  └────────────────────────┘  │     │
│  │  │  Auth      │  │              │  ┌────────────────────────┐  │     │
│  │  │  Manager   │  │              │  │   Auth Manager         │  │     │
│  │  └────────────┘  │              │  └────────────────────────┘  │     │
│  └──────────────────┘              └──────────────────────────────┘     │
│                                                                          │
│  Connection Modes:                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Mode 1: Relay (via Control-Plane)                              │    │
│  │  Client ──WSS──> Control-Plane ──WSS──> Agent                  │    │
│  │                                                               │    │
│  │  Mode 2: P2P Direct Connection                                │    │
│  │  Client ──WSS──> Control-Plane (signaling)                    │    │
│  │  Client ──WSS──> Agent (direct, after IP:port exchange)       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. Local Agent

**Purpose**: Runs on tmux host machines, manages tmux sessions, exposes operations via WebSocket API.

**Responsibilities**:
- Execute tmux commands (create, list, kill, attach sessions)
- Forward terminal I/O between clients and tmux sessions
- Report session status and system metrics to control-plane via heartbeats
- Accept P2P connections from clients (direct WebSocket server)
- Handle multiple concurrent client attachments to same session

**Key Decisions**:
- Uses `libtmux` or direct tmux command execution via `std::process::Command`
- WebSocket server listens on configurable port (default 8080) for both control-plane and P2P client connections
- Spawns separate task per attached session for I/O forwarding
- Maintains local session cache, syncs with tmux server state periodically

**Dependencies**:
- `tokio` - async runtime
- `tokio-tungstenite` - WebSocket server/client
- `rustls` - TLS support
- `serde` / `serde_json` - serialization
- `toml` - configuration parsing
- `tracing` - structured logging

#### 2. Control-Plane

**Purpose**: Central coordinator for agent registration, session discovery, and connection brokering.

**Responsibilities**:
- Accept agent registrations and maintain agent registry
- Process agent heartbeats, detect offline agents
- Maintain global session registry (aggregated from all agents)
- Broker P2P connections (exchange IP:port between client and agent)
- Provide relay fallback when P2P fails
- Store metadata in SQLite database
- Authenticate agents and clients via token validation

**Key Decisions**:
- Single WebSocket server handles both agent and client connections (different message types)
- Stateless design: all state in SQLite, can restart without data loss
- Heartbeat timeout (default 30s) triggers agent offline detection
- Connection broker provides P2P signaling via existing WebSocket connection
- Relay mode forwards all I/O messages between client and agent through control-plane

**Dependencies**:
- `tokio` - async runtime
- `tokio-tungstenite` - WebSocket server
- `rustls` - TLS support
- `rusqlite` - SQLite database
- `serde` / `serde_json` - serialization
- `toml` - configuration parsing
- `tracing` - structured logging

#### 3. CLI Client

**Purpose**: Command-line interface for managing tmux sessions remotely.

**Responsibilities**:
- Connect to control-plane (WSS)
- List agents and sessions
- Attach to sessions (relay or P2P mode)
- Forward terminal I/O
- Handle reconnection on network interruption

**Key Decisions**:
- Uses `crossterm` for terminal manipulation (raw mode, alternate screen)
- Prefers P2P connection when available, falls back to relay
- Stores auth token in memory only (not persisted to disk)
- Automatic reconnection with exponential backoff

**Dependencies**:
- `tokio` - async runtime
- `tokio-tungstenite` - WebSocket client
- `rustls` - TLS support
- `crossterm` - terminal manipulation
- `clap` - CLI argument parsing
- `serde` / `serde_json` - serialization
- `toml` - configuration parsing

#### 4. Web UI Client

**Purpose**: Browser-based interface for managing tmux sessions, accessible from desktop and mobile.

**Responsibilities**:
- Display session dashboard (list of agents and sessions)
- Provide terminal emulator for attached sessions
- Handle authentication (token input)
- Support mobile-responsive layout

**Key Decisions**:
- React + TypeScript frontend (ecosystem maturity, xterm.js compatibility)
- xterm.js for terminal emulation (industry standard, good mobile support)
- Single-page application (SPA) with client-side routing
- WebSocket client connects to control-plane, prefers P2P when available
- Mobile-responsive CSS (flexbox/grid, viewport units)

**Dependencies**:
- React 18+
- xterm.js + xterm-addon-fit
- TypeScript
- Vite (build tool)

## Crate / File Structure

### Rust Workspace Structure

```
nession/
├── Cargo.toml                    # Workspace manifest
├── crates/
│   ├── nession-common/           # Shared types and utilities
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── protocol.rs       # WebSocket message types
│   │       ├── config.rs         # Configuration structs
│   │       ├── auth.rs           # Token validation
│   │       └── error.rs          # Error types
│   │
│   ├── nession-agent/            # Local tmux agent
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs           # Entry point
│   │       ├── lib.rs
│   │       ├── tmux/
│   │       │   ├── mod.rs
│   │       │   ├── manager.rs    # Tmux command execution
│   │       │   ├── session.rs    # Session management
│   │       │   └── io.rs         # Terminal I/O forwarding
│   │       ├── server/
│   │       │   ├── mod.rs
│   │       │   ├── websocket.rs  # WebSocket server
│   │       │   ├── handler.rs    # Message handlers
│   │       │   └── p2p.rs        # P2P connection handling
│   │       ├── registry/
│   │       │   ├── mod.rs
│   │       │   └── session.rs    # Local session registry
│   │       └── heartbeat/
│   │           ├── mod.rs
│   │           └── sender.rs     # Heartbeat to control-plane
│   │
│   ├── nession-control-plane/    # Control-plane server
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs           # Entry point
│   │       ├── lib.rs
│   │       ├── server/
│   │       │   ├── mod.rs
│   │       │   ├── websocket.rs  # WebSocket server
│   │       │   ├── agent.rs      # Agent connection handler
│   │       │   ├── client.rs     # Client connection handler
│   │       │   └── relay.rs      # Relay forwarding
│   │       ├── registry/
│   │       │   ├── mod.rs
│   │       │   ├── agent.rs      # Agent registry
│   │       │   └── session.rs    # Session registry
│   │       ├── broker/
│   │       │   ├── mod.rs
│   │       │   └── connection.rs # P2P connection broker
│   │       └── db/
│   │           ├── mod.rs
│   │           ├── schema.rs     # SQLite schema
│   │           └── queries.rs    # Database operations
│   │
│   └── nession-cli/              # CLI client
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs           # Entry point
│           ├── lib.rs
│           ├── commands/
│           │   ├── mod.rs
│           │   ├── list.rs       # List agents/sessions
│           │   ├── attach.rs     # Attach to session
│           │   ├── create.rs     # Create session
│           │   └── kill.rs       # Kill session
│           ├── terminal/
│           │   ├── mod.rs
│           │   └── raw.rs        # Raw terminal mode
│           └── client/
│               ├── mod.rs
│               ├── websocket.rs  # WebSocket client
│               └── connection.rs # Connection management
│
└── web/                          # Web UI (TypeScript/React)
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── components/
        │   ├── Dashboard.tsx     # Session list
        │   ├── Terminal.tsx      # xterm.js wrapper
        │   └── LoginForm.tsx     # Auth token input
        ├── services/
        │   ├── websocket.ts      # WebSocket client
        │   └── api.ts            # API calls
        └── styles/
            └── main.css          # Mobile-responsive styles
```

## Key Types

### Protocol Messages (`nession-common/src/protocol.rs`)

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Envelope for all WebSocket messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message<T> {
    pub msg_type: String,
    pub id: String,
    pub timestamp: u64,
    pub payload: T,
}

/// Agent registration message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegisterPayload {
    pub agent_id: String,
    pub hostname: String,
    pub ip_address: String,
    pub port: u16,
    pub auth_token: String,
    pub metadata: AgentMetadata,
    pub protocol_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetadata {
    pub tmux_version: String,
    pub os_version: String,
    pub rust_agent_version: String,
}

/// Agent heartbeat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHeartbeatPayload {
    pub agent_id: String,
    pub status: AgentStatus,
    pub session_count: u32,
    pub active_sessions: u32,
    pub metadata: HeartbeatMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Online,
    Offline,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatMetadata {
    pub uptime_seconds: u64,
    pub load_average: [f64; 3],
}

/// Session update message (agent -> control-plane)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUpdatePayload {
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Detached,
    Zombie,
}

/// Client request to list sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSessionsPayload {
    pub agent_id: Option<String>,
}

/// Client request to attach to session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachSessionPayload {
    pub session_id: String,
    pub preferred_mode: ConnectionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionMode {
    P2p,
    Relay,
}

/// P2P connection info (control-plane -> client)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct P2PConnectionInfoPayload {
    pub session_id: String,
    pub agent_ip: String,
    pub agent_port: u16,
    pub connection_token: String,
}

/// Terminal input (client -> agent)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInputPayload {
    pub session_id: String,
    pub data: String,
}

/// Terminal output (agent -> client)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutputPayload {
    pub session_id: String,
    pub data: String,
}

/// Terminal resize (client -> agent)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResizePayload {
    pub session_id: String,
    pub width: u16,
    pub height: u16,
}
```

### Tmux Manager (`nession-agent/src/tmux/manager.rs`)

```rust
use std::collections::HashMap;
use tokio::process::Command;
use anyhow::Result;

/// Manages tmux sessions via command execution
pub struct TmuxManager {
    /// Cache of known sessions
    sessions: HashMap<String, SessionInfo>,
}

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub name: String,
    pub created_at: u64,
    pub window_count: u32,
    pub attached_clients: u32,
    pub width: u16,
    pub height: u16,
}

impl TmuxManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// List all tmux sessions
    pub async fn list_sessions(&mut self) -> Result<Vec<SessionInfo>> {
        let output = Command::new("tmux")
            .args(&["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}\t#{window_width}\t#{window_height}"])
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

        // Update cache
        self.sessions = sessions.iter().map(|s| (s.name.clone(), s.clone())).collect();

        Ok(sessions)
    }

    /// Create a new tmux session
    pub async fn create_session(&mut self, name: &str, width: u16, height: u16) -> Result<()> {
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

        // Refresh cache
        self.list_sessions().await?;

        Ok(())
    }

    /// Kill a tmux session
    pub async fn kill_session(&mut self, name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(&["kill-session", "-t", name])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to kill session: {}", name);
        }

        // Refresh cache
        self.list_sessions().await?;

        Ok(())
    }

    /// Attach to session and get I/O handles
    pub async fn attach_session(&self, name: &str) -> Result<TmuxSessionHandle> {
        // Spawn tmux attach process with pipes for I/O
        let mut child = Command::new("tmux")
            .args(&["attach-session", "-t", name])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("Failed to get stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("Failed to get stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow::anyhow!("Failed to get stderr"))?;

        Ok(TmuxSessionHandle {
            child,
            stdin,
            stdout,
            stderr,
        })
    }

    /// Send keys to a session
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

    /// Resize session
    pub async fn resize_session(&self, session_name: &str, width: u16, height: u16) -> Result<()> {
        let status = Command::new("tmux")
            .args(&[
                "resize-window",
                "-t", session_name,
                "-x", &width.to_string(),
                "-y", &height.to_string(),
            ])
            .status()
            .await?;

        if !status.success() {
            anyhow::bail!("Failed to resize session: {}", session_name);
        }

        Ok(())
    }
}

/// Handle to an attached tmux session for I/O forwarding
pub struct TmuxSessionHandle {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
}

impl TmuxSessionHandle {
    pub fn stdin(&mut self) -> &mut tokio::process::ChildStdin {
        &mut self.stdin
    }

    pub fn stdout(&mut self) -> &mut tokio::process::ChildStdout {
        &mut self.stdout
    }

    pub fn stderr(&mut self) -> &mut tokio::process::ChildStderr {
        &mut self.stderr
    }

    pub async fn wait(&mut self) -> Result<std::process::ExitStatus> {
        let status = self.child.wait().await?;
        Ok(status)
    }
}
```

### Agent Registry (`nession-control-plane/src/registry/agent.rs`)

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};

/// Registry of connected agents
pub struct AgentRegistry {
    agents: Arc<RwLock<HashMap<String, AgentInfo>>>,
    heartbeat_timeout_secs: u64,
}

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

#[derive(Debug, Clone)]
pub struct AgentMetadata {
    pub tmux_version: String,
    pub os_version: String,
    pub rust_agent_version: String,
    pub uptime_seconds: u64,
    pub load_average: [f64; 3],
}

impl AgentRegistry {
    pub fn new(heartbeat_timeout_secs: u64) -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_timeout_secs,
        }
    }

    /// Register a new agent
    pub async fn register(&self, info: AgentInfo) {
        let mut agents = self.agents.write().await;
        agents.insert(info.agent_id.clone(), info);
    }

    /// Update agent heartbeat
    pub async fn update_heartbeat(&self, agent_id: &str, session_count: u32, active_sessions: u32, metadata: AgentMetadata) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.last_heartbeat = Utc::now();
            agent.status = AgentStatus::Online;
            agent.session_count = session_count;
            agent.active_sessions = active_sessions;
            agent.metadata = metadata;
        }
    }

    /// Get agent info
    pub async fn get(&self, agent_id: &str) -> Option<AgentInfo> {
        let agents = self.agents.read().await;
        agents.get(agent_id).cloned()
    }

    /// List all agents
    pub async fn list(&self) -> Vec<AgentInfo> {
        let agents = self.agents.read().await;
        agents.values().cloned().collect()
    }

    /// Mark agent as offline
    pub async fn mark_offline(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.status = AgentStatus::Offline;
        }
    }

    /// Check for offline agents (heartbeat timeout)
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

    /// Remove agent from registry
    pub async fn unregister(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        agents.remove(agent_id);
    }
}
```

### Connection Broker (`nession-control-plane/src/broker/connection.rs`)

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Brokers P2P connections between clients and agents
pub struct ConnectionBroker {
    /// Pending connection requests: connection_id -> (client_ws, agent_id, session_id)
    pending_connections: Arc<RwLock<HashMap<String, PendingConnection>>>,
}

#[derive(Debug)]
pub struct PendingConnection {
    pub connection_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub preferred_mode: ConnectionMode,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionMode {
    P2p,
    Relay,
}

impl ConnectionBroker {
    pub fn new() -> Self {
        Self {
            pending_connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create a new connection request
    pub async fn create_request(&self, agent_id: String, session_id: String, preferred_mode: ConnectionMode) -> String {
        let connection_id = Uuid::new_v4().to_string();
        let pending = PendingConnection {
            connection_id: connection_id.clone(),
            agent_id,
            session_id,
            preferred_mode,
            created_at: chrono::Utc::now(),
        };

        let mut pending_connections = self.pending_connections.write().await;
        pending_connections.insert(connection_id.clone(), pending);

        connection_id
    }

    /// Get pending connection info
    pub async fn get_request(&self, connection_id: &str) -> Option<PendingConnection> {
        let pending_connections = self.pending_connections.read().await;
        pending_connections.get(connection_id).cloned()
    }

    /// Complete connection (remove from pending)
    pub async fn complete_connection(&self, connection_id: &str) {
        let mut pending_connections = self.pending_connections.write().await;
        pending_connections.remove(connection_id);
    }

    /// Clean up stale connection requests (older than 60 seconds)
    pub async fn cleanup_stale_requests(&self) {
        let mut pending_connections = self.pending_connections.write().await;
        let now = chrono::Utc::now();
        pending_connections.retain(|_, conn| {
            let age = (now - conn.created_at).num_seconds();
            age < 60
        });
    }
}
```

### Session Registry (`nession-control-plane/src/registry/session.rs`)

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Global registry of all sessions across all agents
pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionInfo>>>,
}

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,  // Format: {agent_id}:{session_name}
    pub agent_id: String,
    pub session_name: String,
    pub status: SessionStatus,
    pub window_count: u32,
    pub attached_clients: u32,
    pub last_activity: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Detached,
    Zombie,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Update or create session
    pub async fn update_session(&self, session: SessionInfo) {
        let mut sessions = self.sessions.write().await;
        sessions.insert(session.session_id.clone(), session);
    }

    /// Get session info
    pub async fn get(&self, session_id: &str) -> Option<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }

    /// List all sessions
    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    /// List sessions for specific agent
    pub async fn list_by_agent(&self, agent_id: &str) -> Vec<SessionInfo> {
        let sessions = self.sessions.read().await;
        sessions.values()
            .filter(|s| s.agent_id == agent_id)
            .cloned()
            .collect()
    }

    /// Remove session
    pub async fn remove(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }

    /// Remove all sessions for an agent
    pub async fn remove_by_agent(&self, agent_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, s| s.agent_id != agent_id);
    }
}
```

## Data Flow

### Primary Flow: Client Attaches to Session (P2P Mode)

```
┌────────┐                ┌──────────────┐                ┌────────┐
│ Client │                │ Control-Plane│                │  Agent │
└────┬───┘                └──────┬───────┘                └────┬───┘
     │                           │                             │
     │ 1. Connect (WSS)          │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │ 2. Auth (token)           │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │ 3. Request session list   │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │ 4. Return session list    │                             │
     │◄──────────────────────────┤                             │
     │                           │                             │
     │ 5. Attach to session X    │                             │
     │   (preferred_mode: p2p)   │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │                           │ 6. Query agent for session X│
     │                           ├────────────────────────────►│
     │                           │                             │
     │                           │ 7. Return agent IP:port     │
     │                           │◄────────────────────────────┤
     │                           │                             │
     │ 8. P2P connection info    │                             │
     │   (agent IP:port + token) │                             │
     │◄──────────────────────────┤                             │
     │                           │                             │
     │ 9. Direct WSS to agent    │                             │
     │   (with connection token) │                             │
     ├───────────────────────────────────────────────────────────►│
     │                           │                             │
     │                           │                             │ 10. Validate token
     │                           │                             │     and attach
     │                           │                             │
     │ 11. Terminal I/O stream   │                             │
     │◄─────────────────────────────────────────────────────────┤
     │─────────────────────────────────────────────────────────►│
     │                           │                             │
     │                           │                             │
```

### Primary Flow: Client Attaches to Session (Relay Mode)

```
┌────────┐                ┌──────────────┐                ┌────────┐
│ Client │                │ Control-Plane│                │  Agent │
└────┬───┘                └──────┬───────┘                └────┬───┘
     │                           │                             │
     │ 1. Connect (WSS)          │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │ 2. Auth (token)           │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │ 3. Attach to session X    │                             │
     │   (preferred_mode: relay) │                             │
     ├──────────────────────────►│                             │
     │                           │                             │
     │                           │ 4. Notify agent: client     │
     │                           │   attaching to session X    │
     │                           ├────────────────────────────►│
     │                           │                             │
     │                           │                             │ 5. Agent attaches
     │                           │                             │    to tmux session
     │                           │                             │
     │ 6. Relay established      │                             │
     │◄──────────────────────────┤                             │
     │                           │                             │
     │ 7. Terminal input         │                             │
     ├──────────────────────────►│ 8. Forward to agent         │
     │                           ├────────────────────────────►│
     │                           │                             │
     │                           │                             │ 9. tmux I/O
     │                           │ 10. Terminal output         │
     │                           │◄────────────────────────────┤
     │ 11. Terminal output       │                             │
     │◄──────────────────────────┤                             │
     │                           │                             │
```

### Data Flow: Agent Registration and Heartbeat

```
┌────────┐                ┌──────────────┐
│  Agent │                │ Control-Plane│
└────┬───┘                └──────┬───────┘
     │                           │
     │ 1. Startup: check tmux    │
     │                           │
     │ 2. Register (WSS)         │
     │   (agent_id, hostname,    │
     │    IP:port, token,        │
     │    metadata)              │
     ├──────────────────────────►│
     │                           │
     │                           │ 3. Validate token
     │                           │    Store in DB
     │                           │    Add to registry
     │                           │
     │ 4. Registration ack       │
     │◄──────────────────────────┤
     │                           │
     │ 5. Heartbeat (every 10s)  │
     │   (status, session_count, │
     │    active_sessions,       │
     │    metadata)              │
     ├──────────────────────────►│
     │                           │
     │                           │ 6. Update heartbeat timestamp
     │                           │    Update session registry
     │                           │
     │ 7. Heartbeat ack          │
     │◄──────────────────────────┤
     │                           │
     │    ...                    │
     │                           │
     │                           │ 8. Background task: check
     │                           │    for offline agents
     │                           │    (no heartbeat for 30s)
     │                           │    Mark as offline
     │                           │
```

## Edge Cases

| Edge Case | Behavior |
|-----------|----------|
| **Tmux not installed on agent host** | Agent detects missing tmux at startup via `which tmux` command. Exits with clear error message: "tmux not found. Please install tmux 2.6 or later." |
| **Tmux server crash** | Agent detects tmux server failure when `tmux list-sessions` fails. Attempts to restart tmux server. Re-registers with control-plane after restart. Sessions are lost (tmux server state). |
| **Session name conflict** | tmux does not allow duplicate session names. If client requests existing name, agent returns error: "Session already exists". Client should use unique names or append UUID. |
| **Multiple clients attach to same session** | tmux natively supports multiple clients. Agent spawns separate `tmux attach` process per client. All clients receive I/O stream. Input from any client goes to session. |
| **Agent process crash** | Agent attempts graceful shutdown: sends "agent offline" message to control-plane, closes WebSocket connections. If unclean crash, control-plane detects missing heartbeat after 30s, marks agent offline. |
| **Agent disappears without cleanup** | Control-plane background task checks heartbeat timestamps every 10s. If no heartbeat for 30s, marks agent offline. Notifies connected clients. Removes agent sessions from registry. |
| **Control-plane restart** | Agents detect WebSocket disconnection. Automatic reconnection with exponential backoff (1s, 2s, 4s, 8s, max 30s). Re-register on reconnect. Clients reconnect similarly. Session metadata restored from SQLite. |
| **Relay overload** | Control-plane monitors relay connection count. If > 80% of connections use relay, logs warning. Clients can manually specify `preferred_mode: p2p`. Future: automatic suggestion to switch to P2P. |
| **Network interruption during attach** | Client detects WebSocket close. Automatic reconnection attempt. On reconnect, client re-attaches to session. Terminal state restored (resize sent, scrollback if agent buffers). |
| **P2P connection fails** | Client attempts direct WSS to agent IP:port. If connection fails (timeout, refused), client falls back to relay mode automatically. Logs warning about P2P failure. |
| **Both relay and P2P fail** | Client receives error: "Failed to connect to session. Check network connectivity and agent status." Displays troubleshooting steps: verify agent online, check firewall, verify session exists. |
| **Slow network** | Terminal output may lag. Client implements backpressure: if output queue > 100 messages, client requests agent to throttle (lower frame rate for continuous output). No hard frame rate (terminal is event-driven). |
| **Firewall blocking WebSocket** | WebSocket connection fails with timeout or connection refused. Client displays error: "WebSocket connection failed. Check firewall settings. Ensure port 443 (WSS) is accessible." |
| **Invalid UTF-8 input** | Agent validates all client input as UTF-8. If invalid, returns error message: "Invalid UTF-8 input". Input is not forwarded to tmux session. |
| **Message size > 1MB** | Agent and control-plane check message size on receive. If > 1MB, connection is closed with error: "Message too large". Client should split large inputs. |
| **Database corruption** | Control-plane validates SQLite database on startup. If corrupted, attempts recovery via `PRAGMA integrity_check`. If unrecoverable, deletes database and starts fresh (logs warning). |
| **Disk space exhaustion on agent host** | Tmux commands fail. Agent returns error to client: "Agent host disk full". Agent continues running but cannot create/modify sessions. |
| **Duplicate agent ID registration** | Control-plane checks if agent_id already exists. If yes, rejects new registration with error: "Agent ID already registered". Existing agent remains registered. |

## Out of Scope

This architecture deliberately does NOT cover:

- **Control-plane clustering**: v1 is single-instance. Stateless design allows future clustering but implementation is out of scope.
- **NAT traversal**: P2P assumes direct IP:port reachability (intranet deployment). No STUN/TURN/ICE.
- **Multi-tenant isolation**: Single trusted operator model. No user isolation or RBAC.
- **Session recording/playback**: Terminal I/O is forwarded in real-time but not recorded for later playback.
- **AI framework integrations**: System provides primitives (session control, output capture) but no direct LangChain/AutoGPT integration.
- **Desktop native apps**: Web UI covers desktop use cases. No Electron/Tauri apps.
- **File transfer**: No file upload/download between client and agent hosts.
- **Public internet deployment**: No DDoS protection, WAF, or public-facing security hardening.
- **OAuth/OIDC authentication**: Token-based auth only. No OAuth provider integration.
- **Database replication**: SQLite is single-file, no replication. Future: migrate to PostgreSQL for HA.

## Testing Strategy

### Unit Tests

**nession-common**:
- Protocol message serialization/deserialization (all message types)
- Configuration parsing and validation
- Token validation logic
- Error type conversions

**nession-agent**:
- TmuxManager: mock `Command` execution, test session listing/creation/killing
- Session registry: concurrent access, update/remove operations
- Heartbeat sender: message formatting, retry logic

**nession-control-plane**:
- AgentRegistry: registration, heartbeat updates, offline detection
- SessionRegistry: session updates, filtering by agent
- ConnectionBroker: request creation, completion, stale cleanup
- Database: schema creation, queries, migrations

**nession-cli**:
- Command parsing (clap argument validation)
- Terminal raw mode setup/teardown
- WebSocket client message handling

### Integration Tests

**Agent ↔ Control-Plane**:
- Agent registration flow (valid/invalid tokens)
- Heartbeat flow (normal, timeout, recovery)
- Session update propagation (agent creates session, control-plane registry updates)
- Agent disconnection (graceful shutdown, network failure)

**Client ↔ Control-Plane**:
- Client authentication (valid/invalid tokens)
- Session listing (all sessions, filtered by agent)
- Session attach request (P2P and relay modes)
- P2P connection info exchange

**End-to-End**:
- Client attaches to session via relay mode, sends input, receives output
- Client attaches to session via P2P mode, sends input, receives output
- Multiple clients attach to same session concurrently
- Client reconnection after network interruption
- Agent restart while client attached (client detects, reconnects)
- Control-plane restart (agents and clients reconnect)

**Performance Tests**:
- 100 agents registered simultaneously
- 1000 concurrent sessions across 100 agents
- Latency measurement: 1000 keystrokes, measure P95/P99 round-trip
- Agent resource usage: monitor CPU/RAM with 10/50/100 active sessions

**Edge Case Tests**:
- Invalid UTF-8 input rejection
- Message size limit enforcement
- Concurrent session creation with same name (should fail gracefully)
- Agent heartbeat timeout detection
- Database corruption recovery

### Test Infrastructure

- **Mock tmux**: Shell script that simulates tmux commands (list-sessions, new-session, etc.) for unit tests
- **Test control-plane**: In-memory SQLite, configurable heartbeat timeout
- **Load testing**: `tokio` tasks simulating 100+ agents and 1000+ sessions
- **Latency measurement**: Timestamp injection in messages, measure round-trip time
