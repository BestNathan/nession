# Distributed Tmux Agent System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a distributed tmux management system with server, agents, CLI, and Web UI for remote terminal session management.

**Architecture:** Rust workspace with 4 crates (nession-common, nession-server, nession-agent, nession-cli) + React Web UI. Unified `nession` binary with subcommands. WebSocket communication with TLS encryption throughout.

**Tech Stack:** Rust (tokio, tokio-tungstenite, rustls, serde_json, rusqlite), React + TypeScript, xterm.js

---

## Project Setup

### File Structure

```
nession/
├── Cargo.toml                          # Workspace manifest
├── crates/
│   ├── nession-common/                 # Shared types and utilities
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── protocol.rs             # WebSocket message types
│   │       ├── config.rs               # Configuration structs
│   │       └── error.rs                # Error types
│   │
│   ├── nession-server/                 # Server (control-plane)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── lib.rs
│   │       ├── server/
│   │       │   ├── mod.rs
│   │       │   ├── websocket.rs        # WebSocket server
│   │       │   └── handler.rs          # Message handlers
│   │       ├── registry/
│   │       │   ├── mod.rs
│   │       │   ├── agent.rs            # Agent registry
│   │       │   └── session.rs          # Session registry
│   │       └── db/
│   │           ├── mod.rs
│   │           └── schema.rs           # SQLite schema
│   │
│   ├── nession-agent/                  # Local tmux agent
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── lib.rs
│   │       ├── tmux/
│   │       │   ├── mod.rs
│   │       │   ├── manager.rs          # Tmux command execution
│   │       │   └── pty.rs              # Pty control mode
│   │       └── server/
│   │           ├── mod.rs
│   │           └── websocket.rs        # WebSocket server
│   │
│   └── nession-cli/                    # CLI client
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs
│           ├── lib.rs
│           ├── commands/
│           │   ├── mod.rs
│           │   ├── server.rs           # Server subcommands
│           │   ├── agent.rs            # Agent subcommands
│           │   └── client.rs           # Client subcommands
│           └── terminal/
│               ├── mod.rs
│               └── raw.rs              # Raw terminal mode
│
└── web/                                # Web UI
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── components/
        │   ├── Dashboard.tsx
        │   └── Terminal.tsx
        └── services/
            └── websocket.ts

```

---

## Phase 1: Server Implementation

### Task 1.1: Project Setup and Workspace Configuration

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/nession-common/Cargo.toml`
- Create: `crates/nession-server/Cargo.toml`
- Create: `crates/nession-agent/Cargo.toml`
- Create: `crates/nession-cli/Cargo.toml`

- [ ] **Step 1: Create workspace Cargo.toml**

```toml
[workspace]
members = [
    "crates/nession-common",
    "crates/nession-server",
    "crates/nession-agent",
    "crates/nession-cli",
]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"

[workspace.dependencies]
tokio = { version = "1.35", features = ["full"] }
tokio-tungstenite = { version = "0.21", features = ["rustls-tls-webpki-roots"] }
rustls = "0.22"
rustls-pemfile = "2.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
toml = "0.8"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
anyhow = "1.0"
thiserror = "1.0"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1.6", features = ["v4", "serde"] }
rusqlite = { version = "0.30", features = ["bundled"] }
```

- [ ] **Step 2: Create nession-common Cargo.toml**

```toml
[package]
name = "nession-common"
version.workspace = true
edition.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
chrono.workspace = true
uuid.workspace = true
thiserror.workspace = true
```

- [ ] **Step 3: Create nession-server Cargo.toml**

```toml
[package]
name = "nession-server"
version.workspace = true
edition.workspace = true

[[bin]]
name = "nession-server"
path = "src/main.rs"

[dependencies]
nession-common = { path = "../nession-common" }
tokio.workspace = true
tokio-tungstenite.workspace = true
rustls.workspace = true
rustls-pemfile.workspace = true
serde.workspace = true
serde_json.workspace = true
toml.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
anyhow.workspace = true
chrono.workspace = true
uuid.workspace = true
rusqlite.workspace = true
```

- [ ] **Step 4: Create nession-agent Cargo.toml**

```toml
[package]
name = "nession-agent"
version.workspace = true
edition.workspace = true

[[bin]]
name = "nession-agent"
path = "src/main.rs"

[dependencies]
nession-common = { path = "../nession-common" }
tokio.workspace = true
tokio-tungstenite.workspace = true
rustls.workspace = true
rustls-pemfile.workspace = true
serde.workspace = true
serde_json.workspace = true
toml.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
anyhow.workspace = true
chrono.workspace = true
uuid.workspace = true
```

- [ ] **Step 5: Create nession-cli Cargo.toml**

```toml
[package]
name = "nession-cli"
version.workspace = true
edition.workspace = true

[[bin]]
name = "nession"
path = "src/main.rs"

[dependencies]
nession-common = { path = "../nession-common" }
tokio.workspace = true
tokio-tungstenite.workspace = true
rustls.workspace = true
serde.workspace = true
serde_json.workspace = true
toml.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
anyhow.workspace = true
clap = { version = "4.4", features = ["derive"] }
crossterm = "0.27"
```

- [ ] **Step 6: Create placeholder lib.rs files**

Create `crates/nession-common/src/lib.rs`:
```rust
pub mod protocol;
pub mod config;
pub mod error;
```

Create `crates/nession-server/src/lib.rs`:
```rust
pub mod server;
pub mod registry;
pub mod db;
```

Create `crates/nession-agent/src/lib.rs`:
```rust
pub mod tmux;
pub mod server;
```

Create `crates/nession-cli/src/lib.rs`:
```rust
pub mod commands;
pub mod terminal;
```

- [ ] **Step 7: Verify workspace compiles**

Run: `cargo check --workspace`
Expected: Compiles successfully (with warnings about unused imports)

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml crates/*/Cargo.toml crates/*/src/lib.rs
git commit -m "feat: setup Rust workspace with 4 crates"
```

### Task 1.2: Protocol Message Types

**Files:**
- Create: `crates/nession-common/src/protocol.rs`
- Test: `crates/nession-common/tests/protocol_test.rs`

- [ ] **Step 1: Write failing test for message envelope**

Create `crates/nession-common/tests/protocol_test.rs`:
```rust
use nession_common::protocol::{Message, AgentRegisterPayload};

#[test]
fn test_message_envelope_serialization() {
    let msg = Message {
        msg_type: "agent.register".to_string(),
        id: "msg_001".to_string(),
        timestamp: 1234567890,
        payload: serde_json::json!({
            "agent_id": "test_agent",
            "hostname": "test-host",
            "ip_address": "192.168.1.10",
            "port": 8080,
            "auth_token": "token_xyz",
            "metadata": {
                "tmux_version": "3.3a",
                "os_version": "Ubuntu 22.04",
                "nession_version": "0.1.0"
            },
            "protocol_version": "1.0"
        }),
    };
    
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: Message<serde_json::Value> = serde_json::from_str(&json).unwrap();
    
    assert_eq!(decoded.msg_type, "agent.register");
    assert_eq!(decoded.id, "msg_001");
    assert_eq!(decoded.timestamp, 1234567890);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p nession-common --test protocol_test`
Expected: FAIL with "module `protocol` not found"

- [ ] **Step 3: Implement Message struct**

Create `crates/nession-common/src/protocol.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message<T> {
    pub msg_type: String,
    pub id: String,
    pub timestamp: u64,
    pub payload: T,
}

impl<T> Message<T> {
    pub fn new(msg_type: String, id: String, timestamp: u64, payload: T) -> Self {
        Self {
            msg_type,
            id,
            timestamp,
            payload,
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p nession-common --test protocol_test`
Expected: PASS

- [ ] **Step 5: Add payload structs**

Add to `crates/nession-common/src/protocol.rs`:
```rust
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
    pub nession_version: String,
}

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
```

- [ ] **Step 6: Test payload serialization**

Add to `crates/nession-common/tests/protocol_test.rs`:
```rust
use nession_common::protocol::{AgentRegisterPayload, AgentMetadata};

#[test]
fn test_agent_register_payload() {
    let payload = AgentRegisterPayload {
        agent_id: "agent_123".to_string(),
        hostname: "dev-server".to_string(),
        ip_address: "192.168.1.10".to_string(),
        port: 8080,
        auth_token: "token_xyz".to_string(),
        metadata: AgentMetadata {
            tmux_version: "3.3a".to_string(),
            os_version: "Ubuntu 22.04".to_string(),
            nession_version: "0.1.0".to_string(),
        },
        protocol_version: "1.0".to_string(),
    };
    
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AgentRegisterPayload = serde_json::from_str(&json).unwrap();
    
    assert_eq!(decoded.agent_id, "agent_123");
    assert_eq!(decoded.port, 8080);
}
```

- [ ] **Step 7: Run all protocol tests**

Run: `cargo test -p nession-common --test protocol_test`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add crates/nession-common/src/protocol.rs crates/nession-common/tests/protocol_test.rs
git commit -m "feat: add WebSocket protocol message types"
```

---

*Note: This is a large project. Due to response length limits, I'm providing the plan structure and first 2 tasks as examples. The complete plan would continue with:*

**Phase 1 continued:**
- Task 1.3: Configuration structs
- Task 1.4: Error types
- Task 1.5: Agent registry (with tests)
- Task 1.6: Session registry (with tests)
- Task 1.7: SQLite database schema
- Task 1.8: WebSocket server
- Task 1.9: Server main binary
- Task 1.10: Server integration tests

**Phase 2: Agent Implementation** (10+ tasks)

**Phase 3: CLI Implementation** (10+ tasks)

**Phase 4: Web UI Implementation** (10+ tasks)

---

**Would you like me to:**

1. **Continue writing the complete plan** (will be very long, 1000+ lines)
2. **Break into 4 separate plans** (one per phase, more manageable)
3. **Start implementation now** with this partial plan and iterate

Which approach do you prefer?
