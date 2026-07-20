# Plain PTY Attach Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `attach_mode = "plain"` to the agent, spawning `tmux attach` under a PTY instead of control mode (`-C`). Control mode is preserved behind `attach_mode = "control"`.

**Architecture:** One shared PTY per tmux session. `portable-pty` opens a PTY pair, `tmux attach` is spawned on the slave. The master is read in a tokio spawn_blocking loop and broadcast to all connected web clients. Resize uses `master.resize()`. Input from all clients is multiplexed to the PTY. Control-mode code stays unchanged.

**Tech Stack:** Rust (agent) + portable-pty 0.8, TypeScript/React (web client unchanged)

---

## File Structure

### Agent (Rust)
- **Modify:** `crates/nession-agent/Cargo.toml` — add `portable-pty` dependency
- **Modify:** `crates/nession-agent/src/config.rs` — add `AttachMode` enum + field
- **Create:** `crates/nession-agent/src/tmux/pty.rs` — `PtySession` struct
- **Modify:** `crates/nession-agent/src/tmux/mod.rs` — export `pty` module
- **Modify:** `crates/nession-agent/src/server/websocket.rs` — branch on `attach_mode` in `client.attach` handler
- **Create:** `crates/nession-agent/tests/pty_test.rs` — integration test for PTY path

### Already Complete (no changes needed)
- Web client (`Terminal.tsx`, `ConnectionManager`, etc.) — unchanged
- `control.rs`, `control_mode.rs`, `parser.rs` — preserved as-is

---

## Task 1: Add `AttachMode` to agent config

**Files:**
- Modify: `crates/nession-agent/src/config.rs`

- [ ] **Step 1: Write failing test for config parsing**

Add to `crates/nession-agent/src/config.rs` in the existing `#[cfg(test)]` module:

```rust
#[test]
fn test_attach_mode_default_is_plain() {
    let config: AgentConfig = toml::from_str(
        r#"
        agent_id = "test"
        server_url = "ws://localhost:8443"
        auth_token = "tok"
        "#,
    )
    .unwrap();
    assert!(matches!(config.attach_mode, AttachMode::Plain));
}

#[test]
fn test_attach_mode_control() {
    let config: AgentConfig = toml::from_str(
        r#"
        agent_id = "test"
        server_url = "ws://localhost:8443"
        auth_token = "tok"
        attach_mode = "control"
        "#,
    )
    .unwrap();
    assert!(matches!(config.attach_mode, AttachMode::Control));
}
```

Run: `cargo test -p nession-agent config::tests`
Expected: FAIL — `AttachMode` not defined

- [ ] **Step 2: Add `AttachMode` enum and field**

In `crates/nession-agent/src/config.rs`, add before `pub struct AgentConfig`:

```rust
/// How the agent attaches to tmux sessions.
///
/// - `plain`: Spawn `tmux attach` under a real PTY.  tmux handles resize,
///   redraw, and multi-client natively.  One PTY shared per session.
/// - `control`: Use `tmux -C attach` (control mode).  Per-client sessions
///   with structured message parsing.  Preserved for backward compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    Plain,
    Control,
}

impl Default for AttachMode {
    fn default() -> Self {
        AttachMode::Plain
    }
}
```

Then add the field to `AgentConfig` (after `auth_token`):

```rust
    /// How the agent attaches to tmux sessions.  Default: "plain".
    #[serde(default)]
    pub attach_mode: AttachMode,
```

Run: `cargo build -p nession-agent && cargo test -p nession-agent config::tests`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/config.rs
git commit -m "feat(agent): add AttachMode config option (plain/control, default plain)
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Add `portable-pty` dependency

**Files:**
- Modify: `crates/nession-agent/Cargo.toml`

- [ ] **Step 1: Add dependency**

```toml
portable-pty.workspace = true
```

Run: `cargo build -p nession-agent`
Expected: Compiles (dependency downloaded)

- [ ] **Step 2: Commit**

```bash
git add crates/nession-agent/Cargo.toml
git commit -m "chore(agent): add portable-pty dependency for plain attach mode
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Implement `PtySession`

**Files:**
- Create: `crates/nession-agent/src/tmux/pty.rs`

- [ ] **Step 1: Write the module**

Create `crates/nession-agent/src/tmux/pty.rs`:

```rust
//! Plain PTY-based tmux attach session.
//!
//! Uses a real PTY (pseudo-terminal) via `portable-pty`.  A single
//! `tmux attach` subprocess runs on the slave side; the agent reads
//! raw ANSI bytes from the master and forwards them to all connected
//! web clients.  Resize, redraw, and multi-client are handled natively
//! by tmux — no `-C` control-mode parsing required.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, MasterPty, PtySize};
use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Buffer size for reading from the PTY master — 4 KiB per read.
const READ_BUF_SIZE: usize = 4096;

/// One PTY-based tmux session, shared by all attached web clients.
///
/// The PTY master is wrapped in `Arc<Mutex<...>>` so multiple tasks
/// can write input and resize the PTY concurrently.
pub struct PtySession {
    session_name: String,
    child: Box<dyn Child + Send + Sync>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    viewport: (u16, u16),
}

impl PtySession {
    /// Open a PTY, spawn `tmux attach -t <session_name>`, and return
    /// the session plus a receiver for raw ANSI output bytes.
    ///
    /// The returned `mpsc::Receiver<Vec<u8>>` yields chunks of ANSI
    /// data read from the PTY master.  The caller should forward these
    /// to all connected web clients as `terminal.output` messages.
    pub fn attach(
        session_name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
        let pty_system = native_pty_system();
        let pty = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        // Spawn tmux attach with the slave PTY.
        let cmd = Command::new("tmux")
            .args(["attach", "-t", session_name])
            .spawn()
            .with_context(|| format!("failed to spawn tmux attach -t {session_name}"))?;
        let child = pty
            .slave
            .spawn_command(cmd)
            .context("failed to spawn command on PTY slave")?;

        let master = Arc::new(Mutex::new(pty.master));
        let (tx, rx) = mpsc::channel(64);

        // Spawn a blocking reader task — PTY I/O is synchronous, so we
        // use spawn_blocking to avoid blocking the async runtime.
        let master_clone = Arc::clone(&master);
        std::thread::spawn(move || {
            let mut buf = vec![0u8; READ_BUF_SIZE];
            loop {
                let n = {
                    let mut m = master_clone.lock().unwrap();
                    m.read(&mut buf).unwrap_or(0)
                };
                if n == 0 {
                    break; // EOF — tmux subprocess exited
                }
                if tx.blocking_send(buf[..n].to_vec()).is_err() {
                    break; // receiver dropped
                }
            }
        });

        Ok((
            Self {
                session_name: session_name.to_string(),
                child,
                master,
                viewport: (cols, rows),
            },
            rx,
        ))
    }

    /// Write raw input bytes to the PTY (forwarded to tmux).
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut m = self.master.lock().unwrap();
        m.write_all(data)?;
        m.flush()?;
        Ok(())
    }

    /// Resize the PTY.  tmux receives SIGWINCH and reflows automatically.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.viewport = (cols, rows);
        let mut m = self.master.lock().unwrap();
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Current viewport dimensions.
    pub fn viewport(&self) -> (u16, u16) {
        self.viewport
    }

    /// Session name.
    pub fn session_name(&self) -> &str {
        &self.session_name
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Kill the tmux subprocess when the session struct is dropped.
        let _ = self.child.kill();
        // Wait for the child to be reaped.  blocking wait is fine in Drop
        // because the runtime is shutting down or the session is being
        // explicitly dropped.
        let _ = self.child.wait();
    }
}
```

Run: `cargo build -p nession-agent`
Expected: Compiles

- [ ] **Step 2: Add unit test for the module**

Append to the same file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pty_session_attach_to_nonexistent_session_fails() {
        let result = PtySession::attach("__nession_nonexistent_test__", 80, 24);
        // Should fail because the session doesn't exist (no tmux server
        // may be running in CI, so we just check it doesn't panic).
        assert!(result.is_err());
    }
}
```

Run: `cargo test -p nession-agent pty::tests`
Expected: PASS (error is expected — no such tmux session)

- [ ] **Step 3: Export the module**

In `crates/nession-agent/src/tmux/mod.rs`, add:

```rust
pub mod pty;
```

Run: `cargo build -p nession-agent`
Expected: Compiles

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/tmux/pty.rs crates/nession-agent/src/tmux/mod.rs
git commit -m "feat(agent): add PtySession for plain tmux attach with PTY
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Branch `client.attach` handler on `attach_mode`

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs` — around line 902-1000

- [ ] **Step 1: Refactor `client.attach` handler**

Replace the current `msg_types::CLIENT_ATTACH` match arm.  The existing code
wraps `ControlModeSession::attach()` in a match.  We keep that for
`AttachMode::Control` and add the new `AttachMode::Plain` branch.

In the handler, after parsing the payload, add:

```rust
            msg_types::CLIENT_ATTACH => {
                let payload: ClientAttachPayload = match serde_json::from_value(payload_value) {
                    Ok(p) => p,
                    Err(e) => return err("parse_error", &e.to_string()),
                };

                if matches!(config.attach_mode, crate::config::AttachMode::Plain) {
                    // ---- Plain PTY path ----
                    let session_name = payload.session_name.clone();
                    match crate::tmux::pty::PtySession::attach(
                        &session_name,
                        payload.width,
                        payload.height,
                    ) {
                        Ok((mut pty_session, mut output_rx)) => {
                            let sink_output = Arc::clone(&sink);
                            let session_name_output = session_name.clone();
                            tokio::spawn(async move {
                                while let Some(bytes) = output_rx.recv().await {
                                    use base64::Engine;
                                    let encoded = base64::engine::general_purpose::STANDARD
                                        .encode(&bytes);
                                    let output = TerminalOutputPayload {
                                        session_name: session_name_output.clone(),
                                        data: encoded,
                                    };
                                    let msg =
                                        new_message(msg_types::TERMINAL_OUTPUT, output);
                                    if let Ok(json) = serde_json::to_string(&msg) {
                                        let mut s = sink_output.lock().await;
                                        if s.send(WsMessage::Text(json)).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            });

                            let resp = ClientAttachResponse {
                                session_name: session_name.clone(),
                            };
                            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                                .unwrap_or_default()
                        }
                        Err(e) => err("attach_failed", &e.to_string()),
                    }
                } else {
                    // ---- Control mode path (existing) ----
                    match crate::tmux::control::ControlModeSession::attach(
                        &payload.session_name,
                        payload.width,
                        payload.height,
                    )
                    .await
                    {
                        Ok((session, mut output_rx, mut resize_rx)) => {
                            // ... existing control-mode code unchanged ...
                            // (keep the scrollback capture, output task, resize task, ok response)
                            todo!("keep existing control-mode code here")
                        }
                        Err(e) => err("attach_failed", &e.to_string()),
                    }
                }
            }
```

**Note:** The `todo!()` for the control-mode branch is a placeholder for the
existing code.  In practice you move the existing match arms inside the `else`
block.  The existing code spans ~80 lines; it stays unchanged except for the
indentation.

- [ ] **Step 2: Add config reference to handler**

The handler function needs access to `config.attach_mode`.  Currently
`AgentConfig` is not passed to the connection handler.  Add the config as
a parameter or store it in the handler struct.

Simplest approach: read the config at agent startup, store the `attach_mode`
in an `Arc<AttachMode>` or clone it into the handler.

In `crates/nession-agent/src/server/websocket.rs`, find the function that
creates the per-connection handler and pass `config.attach_mode` as a field:

```rust
// In the connection-handling spawn block, after reading config:
let attach_mode = config.attach_mode.clone();
// Pass to the handler or capture in the closure.
```

The handler already captures `sink`, `sessions` (the session map), etc.
Add `attach_mode` as another captured variable.

- [ ] **Step 3: Verify compilation**

Run: `cargo build -p nession-agent`
Expected: Compiles

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs
git commit -m "feat(agent): branch client.attach on config.attach_mode
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Add PTY integration test

**Files:**
- Create: `crates/nession-agent/tests/pty_test.rs`

- [ ] **Step 1: Write integration test**

Create `crates/nession-agent/tests/pty_test.rs`:

```rust
//! Integration test: plain PTY attach mode.
//!
//! Requires a running tmux server with a test session.
//! Skipped in CI environments without tmux.

use nession_agent::server::websocket::{
    msg_types, ClientAttachPayload, ClientDetachPayload, Message, TerminalInputPayload,
};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

fn new_message<P: serde::Serialize>(msg_type: &str, payload: P) -> Message<P> {
    Message {
        msg_type: msg_type.to_string(),
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        payload,
    }
}

#[tokio::test]
#[ignore = "requires running tmux server and agent"]
async fn test_pty_attach_and_echo() {
    // 1. Start agent server
    // 2. Connect WebSocket client
    // 3. Create tmux session
    // 4. Attach via plain PTY
    // 5. Send input, read output, verify echo
    todo!("full integration test — manual for now")
}
```

Run: `cargo test -p nession-agent --test pty_test -- --ignored`
Expected: PASS (ignored)

- [ ] **Step 2: Commit**

```bash
git add crates/nession-agent/tests/pty_test.rs
git commit -m "test(agent): add PTY attach integration test skeleton
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Manual verification

- [ ] **Step 1: Start local stack with plain PTY mode**

```bash
# Build
cargo build -p nession-agent

# Start server (no-auth mode)
HOME=/tmp/nession-demo cargo run -p nession-server &

# Start agent with plain attach mode
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml

# Start web UI
cd web && npm run dev
```

- [ ] **Step 2: Test attach + resize**

1. Open browser, connect, create a session
2. Attach to session — verify terminal shows content
3. Resize browser window — verify PTY resize triggers tmux reflow
4. Type commands — verify input/output works
5. Detach, reattach — verify scrollback is present

- [ ] **Step 3: Test control mode fallback**

Set `attach_mode = "control"` in agent-config.toml, restart agent, verify existing behaviour still works.

---

## Summary

**Total tasks:** 6
**Estimated time:** 1-2 days
**Key deliverables:**
- `AttachMode` config enum (plain default, control preserved)
- `PtySession` struct using `portable-pty`
- `client.attach` handler branching on config
- Integration test skeleton
- Control-mode code untouched
