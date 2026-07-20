# Relay Mode Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix relay mode attach by having the server inject `client.attach` (with env vars) before bidirectional forwarding, unifying relay messages to agent protocol format (`session_name`, base64), and adding graceful `client.detach` on teardown.

**Architecture:** Server translates `client.session.attach` → `client.attach` to agent before entering relay forwarding. Browser sends agent-protocol messages through server relay (transparent proxy). Env vars flow from attach dialog → server → agent `client.attach` payload → `tmux set-environment` → PTY creation.

**Tech Stack:** Rust (tokio, tungstenite, serde, base64), TypeScript (xterm.js, WebSocket)

**Spec:** `docs/superpowers/specs/2026-07-20-relay-mode-attach-design.md`
**Issue:** [#34](https://github.com/bestnathan/nession/issues/34)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `crates/nession-common/src/protocol.rs` | Modify | Add `env_snapshots` to `ClientSessionAttachPayload` |
| `crates/nession-agent/src/tmux/manager.rs` | Modify | Add `set_environment()` method for `tmux set-environment` |
| `crates/nession-agent/src/server/websocket.rs` | Modify | Add `env_snapshots` to `ClientAttachPayload`, apply env in CLIENT_ATTACH handler |
| `crates/nession-server/src/server/handler.rs` | Modify | Update `HandlerAction::Relay`, resolve env_snapshots in attach handler |
| `crates/nession-server/src/server/websocket.rs` | Modify | Inject `client.attach` before relay, send `client.detach` on exit |
| `web/src/services/websocket.ts` | Modify | Add `sendRelayInput()`, `sendRelayResize()` with base64 + `session_name` |
| `web/src/terminal/ConnectionManager.ts` | Modify | Relay send/sendResize uses agent protocol format |
| `web/src/types.ts` | Modify | Add relay methods to type (if needed) |

---

### Task 1: Add `env_snapshots` to common protocol `ClientSessionAttachPayload`

**Files:**
- Modify: `crates/nession-common/src/protocol.rs:280-291`

- [ ] **Step 1: Add `env_snapshots` field**

Add `env_snapshots: Vec<EnvSnapshot>` with `#[serde(default)]` to `ClientSessionAttachPayload`:

```rust
/// `client.session.attach` — request to attach to a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionAttachPayload {
    pub session_id: String,
    /// "auto" | "p2p" | "relay". The client resolves "auto" itself by first
    /// asking for "p2p" and falling back to "relay", so the server only ever
    /// sees "p2p" or "relay" in practice.
    #[serde(default = "default_attach_mode")]
    pub preferred_mode: String,
    /// Resolved env-file snapshots for attach-time injection (relay mode).
    /// Empty (default) preserves the pre-env-feature behaviour.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
}
```

- [ ] **Step 2: Build and test**

```bash
cargo build -p nession-common
```

Expected: compiles cleanly.

- [ ] **Step 3: Add serde round-trip test**

In `crates/nession-common/src/protocol.rs` test module, add:

```rust
#[test]
fn test_client_session_attach_payload_default_env_snapshots() {
    let json = serde_json::json!({
        "session_id": "agent:session",
        "preferred_mode": "relay"
    });
    let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.session_id, "agent:session");
    assert_eq!(payload.preferred_mode, "relay");
    assert!(payload.env_snapshots.is_empty());
}

#[test]
fn test_client_session_attach_payload_with_env_snapshots() {
    let json = serde_json::json!({
        "session_id": "agent:session",
        "preferred_mode": "relay",
        "env_snapshots": [{
            "name": "staging.env",
            "source": "server",
            "vars": [["NODE_ENV", "staging"], ["DEBUG", "true"]],
            "warnings": []
        }]
    });
    let payload: ClientSessionAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(payload.env_snapshots.len(), 1);
    assert_eq!(payload.env_snapshots[0].name, "staging.env");
    assert_eq!(payload.env_snapshots[0].vars.len(), 2);
}
```

- [ ] **Step 4: Run tests**

```bash
cargo test -p nession-common
```

Expected: all tests pass including new ones.

- [ ] **Step 5: Commit**

```bash
git add crates/nession-common/src/protocol.rs
git commit -m "feat: add env_snapshots to ClientSessionAttachPayload (ISSUE#34)"
```

---

### Task 2: Add `set_environment` method to `TmuxManager`

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs:94-130` (after `create_session`)

- [ ] **Step 1: Add `set_environment` method**

Insert after `create_session` (after line 130):

```rust
    /// Set tmux-level environment variables on a running session.
    /// Uses `tmux set-environment -t <session> KEY VALUE` which makes
    /// variables available to new windows/panes in that session.
    /// Non-fatal: errors are returned but callers may treat them as warnings.
    pub async fn set_environment(
        &self,
        session_name: &str,
        vars: &[(String, String)],
    ) -> Result<(), Vec<String>> {
        let mut warnings = Vec::new();
        for (key, value) in vars {
            let status = Command::new("tmux")
                .args([
                    "set-environment",
                    "-t",
                    session_name,
                    "-e",
                    &format!("{key}={value}"),
                ])
                .status()
                .await;
            match status {
                Ok(s) if !s.success() => {
                    warnings.push(format!("set-environment {key}={value} failed"));
                }
                Err(e) => {
                    warnings.push(format!("set-environment {key}={value}: {e}"));
                }
                _ => {}
            }
        }
        if warnings.is_empty() {
            Ok(())
        } else {
            Err(warnings)
        }
    }
```

- [ ] **Step 2: Build check**

```bash
cargo build -p nession-agent
```

Expected: compiles.

- [ ] **Step 3: Add unit test**

In `crates/nession-agent/src/tmux/manager.rs` test module, add:

```rust
#[tokio::test]
async fn set_environment_on_nonexistent_session_returns_warnings() {
    let mgr = TmuxManager::new();
    let result = mgr
        .set_environment(
            "nession_nonexistent_xyz_123",
            &[("KEY".to_string(), "VALUE".to_string())],
        )
        .await;
    // Should return warnings (session doesn't exist) but not panic.
    assert!(result.is_err());
}
```

- [ ] **Step 4: Run tmux manager tests**

```bash
cargo test -p nession-agent -- tmux::manager
```

Expected: all tests pass (requires tmux on host).

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "feat: add TmuxManager::set_environment for attach-time env (ISSUE#34)"
```

---

### Task 3: Add `env_snapshots` to agent `ClientAttachPayload` + apply env in attach handler

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs:197-203` (ClientAttachPayload)
- Modify: `crates/nession-agent/src/server/websocket.rs:955-1192` (CLIENT_ATTACH handler)

- [ ] **Step 1: Add `env_snapshots` field to `ClientAttachPayload`**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAttachPayload {
    pub session_name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
    /// Resolved env-file snapshots to apply via `tmux set-environment`
    /// before PTY creation. Empty (default) preserves pre-env behaviour.
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,
}
```

Also add the import at the top of the file (after existing imports):

```rust
use nession_common::protocol::EnvSnapshot;
```

- [ ] **Step 2: Add `apply_env_snapshots` helper function**

Add before the `impl AgentServer` block:

```rust
/// Apply env snapshots to a tmux session via `set-environment`.
/// Returns warnings for keys that failed (non-fatal).
async fn apply_env_snapshots(
    tmux: &TmuxManager,
    session_name: &str,
    snapshots: &[EnvSnapshot],
) -> Vec<String> {
    let vars: Vec<(String, String)> = snapshots
        .iter()
        .flat_map(|s| s.vars.clone())
        .collect();
    // Deduplicate: last snapshot wins for same key.
    let mut seen = std::collections::HashMap::new();
    let mut deduped = Vec::new();
    for (k, v) in vars {
        seen.insert(k.clone(), v.clone());
    }
    for (k, v) in seen {
        deduped.push((k, v));
    }
    match tmux.set_environment(session_name, &deduped).await {
        Ok(()) => Vec::new(),
        Err(warnings) => warnings,
    }
}
```

- [ ] **Step 3: Apply env vars in CLIENT_ATTACH handler (Plain PTY path)**

In the `CLIENT_ATTACH` handler, right before the `PtySession::attach()` call (around line 1002-1007), add env application:

At the point where `session_name` is available and before the Plain PTY block (after `let mut sessions_guard = sessions.lock().await;` around line 964), add:

```rust
// Apply env snapshots before PTY creation (non-fatal).
let env_warnings = if !payload.env_snapshots.is_empty() {
    apply_env_snapshots(&tmux, &session_name, &payload.env_snapshots).await
} else {
    Vec::new()
};
if !env_warnings.is_empty() {
    for w in &env_warnings {
        warn!("env set-environment warning for session {}: {w}", session_name);
    }
}
```

Also apply the same logic in the Control mode path (around line 1069-1070). Add the same env_warnings code block before `ControlModeSession::attach()`.

- [ ] **Step 4: Build check**

```bash
cargo build -p nession-agent
```

Expected: compiles.

- [ ] **Step 5: Update existing test to verify env_snapshots defaults**

In the test `test_client_attach_payload_defaults`, add:

```rust
#[test]
fn test_client_attach_payload_defaults() {
    let json = serde_json::json!({"session_name": "s"});
    let p: ClientAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(p.session_name, "s");
    assert_eq!(p.width, 80);
    assert_eq!(p.height, 24);
    assert!(p.env_snapshots.is_empty());  // NEW
}
```

- [ ] **Step 6: Add test for env_snapshots in ClientAttachPayload serde**

```rust
#[test]
fn test_client_attach_payload_with_env_snapshots() {
    let json = serde_json::json!({
        "session_name": "s",
        "width": 120,
        "height": 40,
        "env_snapshots": [{
            "name": "test.env",
            "source": "server",
            "vars": [["KEY", "VAL"]],
            "warnings": []
        }]
    });
    let p: ClientAttachPayload = serde_json::from_value(json).unwrap();
    assert_eq!(p.env_snapshots.len(), 1);
    assert_eq!(p.env_snapshots[0].vars[0], ("KEY".to_string(), "VAL".to_string()));
}
```

- [ ] **Step 7: Run agent server tests**

```bash
cargo test -p nession-agent -- server::websocket
```

Expected: all tests pass (requires tmux).

- [ ] **Step 8: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs crates/nession-agent/src/tmux/manager.rs
git commit -m "feat: apply env_snapshots in agent CLIENT_ATTACH handler (ISSUE#34)"
```

---

### Task 4: Update `HandlerAction::Relay` to carry `session_name` + `env_snapshots`

**Files:**
- Modify: `crates/nession-server/src/server/handler.rs:17-33` (HandlerAction enum)
- Modify: `crates/nession-server/src/server/handler.rs:664-686` (relay case in attach handler)
- Modify: `crates/nession-server/src/server/websocket.rs:338-353` (match on HandlerAction::Relay)

- [ ] **Step 1: Update `HandlerAction::Relay`**

```rust
pub enum HandlerAction {
    Reply(Option<Message>),
    Relay {
        agent_ws_url: String,
        /// Session id ("agent_id:session_name").
        session_id: String,
        /// Short session name for agent protocol messages.
        session_name: String,
        /// Unique client id for this relay connection.
        client_id: String,
        /// Resolved env snapshots to inject via client.attach.
        env_snapshots: Vec<EnvSnapshot>,
    },
    Close,
}
```

Add import if not already present:
```rust
use nession_common::protocol::{..., EnvSnapshot};
```

- [ ] **Step 2: Update relay case in `handle_client_session_attach`**

Replace the relay block (lines 664-686) with:

```rust
        if preferred_mode == "relay" {
            // Resolve env snapshots if provided in the attach request.
            let attach_env_snapshots: Vec<EnvSnapshot> = msg
                .payload
                .get("env_snapshots")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            if !attach_env_snapshots.is_empty() {
                info!(
                    "Relay attach with {} env snapshot(s) for session {}",
                    attach_env_snapshots.len(),
                    session_name
                );
            }

            let client_id = uuid::Uuid::new_v4().to_string();
            if let Some(ref sender) = self.client_sender {
                self.client_registry
                    .register(session_id, &client_id, sender.clone())
                    .await;
            }
            self.attached_session_id = Some(session_id.to_string());
            self.attached_client_id = Some(client_id.clone());
            Ok(HandlerAction::Relay {
                agent_ws_url,
                session_id: session_id.to_string(),
                session_name: session_name.clone(),
                client_id,
                env_snapshots: attach_env_snapshots,
            })
```

- [ ] **Step 3: Update match arm in `websocket.rs`**

In `handle_ws_stream` (websocket.rs:338-353), update the Relay match:

```rust
            HandlerAction::Relay {
                agent_ws_url,
                session_id: _,
                session_name,
                client_id: _,
                env_snapshots,
            } => {
                relay_bidirectional_via_channel(
                    &mut read,
                    sender.clone(),
                    &agent_ws_url,
                    &session_name,
                    &env_snapshots,
                )
                .await?;
                break;
            }
```

- [ ] **Step 4: Build check**

```bash
cargo build -p nession-server
```

Expected: compiles (but relay_bidirectional_via_channel signature changed — don't worry, we fix it in Task 5).

- [ ] **Step 5: Commit**

```bash
git add crates/nession-server/src/server/handler.rs crates/nession-server/src/server/websocket.rs
git commit -m "feat: extend HandlerAction::Relay with session_name and env_snapshots (ISSUE#34)"
```

---

### Task 5: Update `relay_bidirectional_via_channel` to inject `client.attach` and send `client.detach`

**Files:**
- Modify: `crates/nession-server/src/server/websocket.rs:382-526`

- [ ] **Step 1: Update function signature**

```rust
async fn relay_bidirectional_via_channel<RS>(
    client_read: &mut RS,
    sender: crate::server::command_broker::WsMessageSender,
    agent_ws_url: &str,
    session_name: &str,
    env_snapshots: &[EnvSnapshot],
) -> anyhow::Result<()>
```

Add import at top of file:
```rust
use nession_common::protocol::EnvSnapshot;
```

- [ ] **Step 2: Replace function body with attach-before-relay version**

Replace the entire function body after the signature with:

```rust
{
    use futures_util::SinkExt;
    use futures_util::StreamExt;

    info!(
        "Entering relay mode for session '{}', connecting to agent at {}",
        session_name, agent_ws_url
    );

    let (agent_ws, _) = tokio_tungstenite::connect_async(agent_ws_url).await?;
    let (mut agent_write, mut agent_read) = agent_ws.split();

    // ── Step 1: Send client.attach to agent ──
    let attach_msg = serde_json::json!({
        "msg_type": "client.attach",
        "id": uuid::Uuid::new_v4().to_string(),
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        "payload": {
            "session_name": session_name,
            "width": 80,
            "height": 24,
            "env_snapshots": env_snapshots,
        }
    });
    agent_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            attach_msg.to_string(),
        ))
        .await?;

    // Wait for ok/error response from agent.
    let attach_response = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        agent_read.next(),
    )
    .await;
    match attach_response {
        Ok(Some(Ok(msg))) => {
            if let Ok(text) = msg.to_text() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
                    let resp_type = parsed
                        .get("msg_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if resp_type == "error" {
                        let err_msg = parsed
                            .get("payload")
                            .and_then(|p| p.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("attach failed");
                        error!("Agent rejected attach for session '{}': {}", session_name, err_msg);
                        // Forward error to browser client
                        let client_error = tokio_tungstenite::tungstenite::Message::Text(
                            serde_json::json!({
                                "msg_type": "error",
                                "id": uuid::Uuid::new_v4().to_string(),
                                "timestamp": std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs(),
                                "payload": {
                                    "code": "attach_failed",
                                    "message": format!("Failed to attach to session '{}': {}", session_name, err_msg),
                                }
                            })
                            .to_string(),
                        );
                        let _ = sender.send(client_error);
                        return Ok(());
                    }
                    info!(
                        "Agent confirmed attach for session '{}' (msg_type={})",
                        session_name, resp_type
                    );
                }
            }
        }
        Ok(Some(Err(e))) => {
            error!("WebSocket error waiting for attach response: {}", e);
            return Err(anyhow::anyhow!("Agent connection error during attach: {}", e));
        }
        Ok(None) => {
            error!("Agent closed connection during attach");
            return Err(anyhow::anyhow!("Agent closed connection before accepting attach"));
        }
        Err(_) => {
            error!("Timeout waiting for agent attach response (10s)");
            return Err(anyhow::anyhow!(
                "Timeout waiting for agent to accept attach for session '{}'",
                session_name
            ));
        }
    }

    info!("Relay established for session '{}'", session_name);

    // ── Step 2: Bidirectional forwarding (same as before) ──

    // Helper: detect terminal.input JSON messages.
    fn is_terminal_input(msg: &tokio_tungstenite::tungstenite::Message) -> bool {
        msg.to_text()
            .ok()
            .map(|t| t.contains("\"terminal.input\""))
            .unwrap_or(false)
    }

    const INPUT_THROTTLE_MS: u64 = 16;
    let mut last_terminal_input = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(60))
        .unwrap_or(std::time::Instant::now());

    let client_to_agent = async {
        while let Some(msg) = client_read.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    error!("Error reading from client: {}", e);
                    break;
                }
            };

            if !is_terminal_input(&msg) {
                if let Err(e) = agent_write.send(msg).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
                continue;
            }

            let elapsed = last_terminal_input.elapsed();
            if elapsed < std::time::Duration::from_millis(INPUT_THROTTLE_MS) {
                let drain_deadline =
                    last_terminal_input + std::time::Duration::from_millis(INPUT_THROTTLE_MS);
                let mut latest = msg;

                loop {
                    let remaining =
                        drain_deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match tokio::time::timeout(remaining, client_read.next()).await {
                        Ok(Some(Ok(m))) if is_terminal_input(&m) => {
                            latest = m;
                        }
                        Ok(Some(Ok(m))) => {
                            let _ = agent_write.send(m).await;
                            break;
                        }
                        Ok(Some(Err(e))) => {
                            error!("Error reading from client: {}", e);
                            break;
                        }
                        Ok(None) | Err(tokio::time::error::Elapsed { .. }) => {
                            break;
                        }
                    }
                }

                if let Err(e) = agent_write.send(latest).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
                last_terminal_input = std::time::Instant::now();
            } else {
                last_terminal_input = std::time::Instant::now();
                if let Err(e) = agent_write.send(msg).await {
                    error!("Failed to forward client message to agent: {}", e);
                    break;
                }
            }
        }
    };

    let agent_to_client = async {
        while let Some(msg) = agent_read.next().await {
            match msg {
                Ok(msg) => {
                    if let Err(e) = sender.send(msg) {
                        error!("Failed to forward agent message to client: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    error!("Error reading from agent: {}", e);
                    break;
                }
            }
        }
    };

    tokio::select! {
        _ = client_to_agent => {
            info!("Client to agent relay ended for session '{}'", session_name);
        }
        _ = agent_to_client => {
            info!("Agent to client relay ended for session '{}'", session_name);
        }
    }

    // ── Step 3: Send client.detach on exit (best-effort) ──
    // We need a fresh connection since the relay WS may have been dropped.
    if let Ok((mut detach_ws, _)) = tokio_tungstenite::connect_async(agent_ws_url).await {
        let detach_msg = serde_json::json!({
            "msg_type": "client.detach",
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "payload": {
                "session_name": session_name,
            }
        });
        let _ = detach_ws
            .send(tokio_tungstenite::tungstenite::Message::Text(
                detach_msg.to_string(),
            ))
            .await;
        info!(
            "Sent client.detach for session '{}' (best-effort)",
            session_name
        );
    }

    info!("Relay mode ended for session '{}'", session_name);
    Ok(())
}
```

- [ ] **Step 2: Build check**

```bash
cargo build -p nession-server
```

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-server/src/server/websocket.rs
git commit -m "feat: inject client.attach before relay, send client.detach on exit (ISSUE#34)"
```

---

### Task 6: Add relay-specific send methods to `WebSocketService`

**Files:**
- Modify: `web/src/services/websocket.ts:475-512` (after sendTerminalResize)

- [ ] **Step 1: Add base64 helper and relay send methods**

Add after `sendTerminalResize` (after line 512):

```typescript
  // ── Relay mode terminal I/O (agent protocol format) ──

  private encodeBase64(data: string): string {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Send terminal input in agent protocol format (base64, session_name). */
  sendRelayInput(sessionName: string, data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const message: WebSocketMessage = {
      msg_type: 'terminal.input',
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload: {
        session_name: sessionName,
        data: this.encodeBase64(data),
      },
    };

    this.ws.send(JSON.stringify(message));
  }

  /** Send terminal resize in agent protocol format (session_name). */
  sendRelayResize(sessionName: string, cols: number, rows: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const message: WebSocketMessage = {
      msg_type: 'terminal.resize',
      id: this.generateMessageId(),
      timestamp: Date.now(),
      payload: {
        session_name: sessionName,
        cols,
        rows,
      },
    };

    this.ws.send(JSON.stringify(message));
  }
```

- [ ] **Step 2: Build check**

```bash
cd web && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Add unit test**

In `web/src/services/__tests__/websocket.test.ts` (create if needed), add:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketService } from '../websocket';

describe('WebSocketService relay methods', () => {
  let service: WebSocketService;

  beforeEach(() => {
    service = new WebSocketService('ws://localhost:19090/ws', 'test-token');
  });

  it('sendRelayInput base64-encodes data and uses session_name', () => {
    const sendSpy = vi.fn();
    // @ts-expect-error - accessing private ws for testing
    service['ws'] = { readyState: WebSocket.OPEN, send: sendSpy };

    service.sendRelayInput('mysession', 'hello');

    const sent = JSON.parse(sendSpy.mock.calls[0][0]);
    expect(sent.msg_type).toBe('terminal.input');
    expect(sent.payload.session_name).toBe('mysession');
    // Verify base64 encoding of "hello"
    expect(sent.payload.data).toBe('aGVsbG8=');
    // Verify NO session_id field
    expect(sent.payload.session_id).toBeUndefined();
  });

  it('sendRelayResize uses session_name', () => {
    const sendSpy = vi.fn();
    // @ts-expect-error
    service['ws'] = { readyState: WebSocket.OPEN, send: sendSpy };

    service.sendRelayResize('mysession', 120, 40);

    const sent = JSON.parse(sendSpy.mock.calls[0][0]);
    expect(sent.msg_type).toBe('terminal.resize');
    expect(sent.payload.session_name).toBe('mysession');
    expect(sent.payload.cols).toBe(120);
    expect(sent.payload.rows).toBe(40);
    expect(sent.payload.session_id).toBeUndefined();
  });

  it('sendRelayInput throws when not connected', () => {
    expect(() => service.sendRelayInput('s', 'data')).toThrow('not connected');
  });
});
```

- [ ] **Step 4: Run web tests**

```bash
cd web && npm test
```

Expected: new tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/websocket.ts web/src/services/__tests__/websocket.test.ts
git commit -m "feat: add relay-specific send methods with base64 + session_name (ISSUE#34)"
```

---

### Task 7: Update `ConnectionManager` to use agent protocol format for relay

**Files:**
- Modify: `web/src/terminal/ConnectionManager.ts:61-96` (send and sendResize methods)

- [ ] **Step 1: Update `send()` relay branch**

Replace lines 71-72:

```typescript
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendTerminalInput(this.sessionId, data);
      }
```

With:

```typescript
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendRelayInput(this.sessionName, data);
      }
```

- [ ] **Step 2: Update `sendResize()` relay branch**

Replace lines 90-91:

```typescript
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendTerminalResize(this.sessionId, cols, rows);
      }
```

With:

```typescript
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendRelayResize(this.sessionName, cols, rows);
      }
```

- [ ] **Step 3: Build check**

```bash
cd web && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Run ConnectionManager tests**

```bash
cd web && npm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add web/src/terminal/ConnectionManager.ts
git commit -m "feat: use agent protocol format for relay send/sendResize (ISSUE#34)"
```

---

### Task 8: Full stack build + lint + test

**Files:**
- None (verification only)

- [ ] **Step 1: Rust build all crates**

```bash
cargo build
```

Expected: all 4 crates compile clean.

- [ ] **Step 2: Rust tests**

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 3: Clippy**

```bash
cargo clippy -- -D warnings
```

Expected: 0 warnings.

- [ ] **Step 4: Format check**

```bash
cargo fmt --all -- --check
```

Expected: clean.

- [ ] **Step 5: Web build**

```bash
cd web && npm run build
```

Expected: success.

- [ ] **Step 6: Web lint + type check**

```bash
cd web && npm run lint && npx tsc --noEmit
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 7: Web tests**

```bash
cd web && npm test && npm run coverage
```

Expected: all pass, ≥ 80% coverage.

- [ ] **Step 8: Commit (if any fixes from lint)**

```bash
git add -A && git commit -m "chore: fix lint issues from relay attach implementation (ISSUE#34)"
```

---

### Task 9: Playwright verification (MANDATORY)

**Files:**
- None (verification only)

- [ ] **Step 1: Start local stack**

```bash
# Terminal 1: Server
HOME=/tmp/nession-demo cargo run -p nession-server

# Terminal 2: Agent
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml

# Terminal 3: Web UI
cd web && npm run dev
```

- [ ] **Step 2: Navigate to app and log in**

Use Playwright MCP:
- `mcp__playwright__browser_navigate` to `http://localhost:13000`
- `mcp__playwright__browser_snapshot` to inspect login page
- Fill in auth token and log in

- [ ] **Step 3: Create a test session**

- Click "Create Session" on an agent card
- Enter a name like "relay-test"
- Click Create

- [ ] **Step 4: Attach via relay mode and verify**

- Click "Attach" on the session, selecting "Relay" mode
- Verify: terminal appears with tmux output within 2 seconds
- Type `echo hello-relay` and verify output appears
- Take screenshot: `mcp__playwright__browser_take_screenshot`

- [ ] **Step 5: Verify env vars flow through**

- Create an env file from the env panel
- Attach with env file selected
- In the terminal, run `echo $TEST_VAR` (or whatever key you set)
- Verify: env var is set in the tmux session

- [ ] **Step 6: Verify terminal resize**

- Resize the browser window
- Verify: tmux session resizes accordingly (content reflows)

- [ ] **Step 7: Verify error handling**

- Stop the agent, try to attach via relay
- Verify: error toast appears with meaningful message

- [ ] **Step 8: Collect screenshots**

```bash
ls .playwright-mcp/screenshots/
```
Save screenshots for PR body.

---

### Task 10: Final commit and push

- [ ] **Step 1: Final verification**

```bash
cargo test && cargo clippy -- -D warnings && cargo fmt --all -- --check
cd web && npm run build && npm run lint && npm test && cd ..
```

- [ ] **Step 2: Push and create PR**

```bash
git push -u origin feat/relay-mode-attach
gh pr create \
  --title "feat: relay mode attach with env vars support" \
  --body "$(cat <<'EOF'
## 变更内容
- Fix relay mode attach: server injects `client.attach` before bidirectional forwarding (G1)
- Unify relay messages to agent protocol format: `session_name` + base64 encoding (G2, G3, G6)
- Add `client.detach` on graceful relay teardown (G4)
- Add `env_snapshots` to `ClientAttachPayload` for single-step attach with env vars (G5)
- Add `TmuxManager::set_environment()` for attach-time env injection
- Add `sendRelayInput`/`sendRelayResize` to WebSocketService

Closes #34

## 测试报告
<!-- Fill in after running all checks -->

## 核心功能截图
<!-- Add Playwright screenshots here -->
EOF
)"
```

---

## Implementation Order

```
Task 1 (protocol types)
  → Task 2 (TmuxManager.set_environment)
    → Task 3 (agent attach handler)
  → Task 4 (HandlerAction::Relay)
    → Task 5 (relay_bidirectional_via_channel)
  → Task 6 (WebSocketService relay methods)
    → Task 7 (ConnectionManager relay format)
→ Task 8 (full build + lint + test)
→ Task 9 (Playwright verification)
→ Task 10 (PR)
```
