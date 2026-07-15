# Per-Attach Env Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement per-client env file tracking so multiple clients attaching to the same tmux session can independently source env files, and detaching one client only cleans up that client's scripts.

**Architecture:** Add `client_id` field to protocol auth messages. Agent generates/assigns client_id if not provided. Script paths include client_id: `/tmp/nession-{source,unsource}-{client_id}-{session}-{env}`. Agent tracks client_id per connection and cleans up on disconnect. Clients persist client_id locally (localStorage for web, file for CLI).

**Tech Stack:** Rust (tokio, serde, uuid), TypeScript (React), WebSocket protocol

---

## File Structure

**Modified Files:**
1. `crates/nession-common/src/protocol.rs` — Add client_id to auth payloads
2. `crates/nession-agent/src/tmux/manager.rs` — Update source_env/unsource_env to accept client_id, add cleanup_client_scripts method
3. `crates/nession-agent/src/server/websocket.rs` — Track client_id per connection, pass to source_env/unsource_env, cleanup on detach
4. `crates/nession-agent/src/connection/server_client.rs` — Pass client_id when calling source_env/unsource_env (from server messages)
5. `web/src/services/websocket.ts` — Generate/persist client_id in localStorage, send in auth
6. `crates/nession-cli/src/client/connection.rs` — Generate/persist client_id in file, send in auth

**Test Files:**
1. `crates/nession-agent/src/tmux/manager.rs` (inline tests) — Test per-client script paths and cleanup
2. `crates/nession-agent/src/server/websocket.rs` (inline tests) — Test multi-client scenarios

---

## Task 1: Protocol Changes — Add client_id to Auth

**Files:**
- Modify: `crates/nession-common/src/protocol.rs:199-208`

- [ ] **Step 1: Update ClientAuthPayload to include client_id**

Open `crates/nession-common/src/protocol.rs`, find the `ClientAuthPayload` struct (around line 199):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    #[serde(default)]
    pub auth_token: String,
}
```

Update it to:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub client_id: Option<String>,
}
```

- [ ] **Step 2: Update AuthResponsePayload to include client_id**

Find `AuthResponsePayload` (around line 205):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponsePayload {
    pub status: String,
    pub message: String,
}
```

Update it to:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponsePayload {
    pub status: String,
    pub message: String,
    pub client_id: String,
}
```

- [ ] **Step 3: Verify compilation**

```bash
cargo check -p nession-common
```

Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add crates/nession-common/src/protocol.rs
git commit -m "feat(protocol): add client_id to auth messages

Add optional client_id field to ClientAuthPayload for per-client
env tracking. AuthResponse now returns assigned client_id.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: TmuxManager — Per-Client Script Paths

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs:7-17,118-160`
- Add: `crates/nession-agent/src/tmux/manager.rs` (new method + tests)

- [ ] **Step 1: Write failing test for per-client script paths**

Open `crates/nession-agent/src/tmux/manager.rs`, scroll to the bottom (before the `impl Default` block around line 195). Add:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_script_paths_include_client_id() {
        let path = source_script_path("client-123", "session-x", "staging");
        assert_eq!(
            path.to_str().unwrap(),
            "/tmp/nession-source-client-123-session-x-staging"
        );

        let path = unsource_script_path("client-456", "session-y", "prod");
        assert_eq!(
            path.to_str().unwrap(),
            "/tmp/nession-unsource-client-456-session-y-prod"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p nession-agent tmux::manager::tests::test_script_paths_include_client_id
```

Expected: FAIL — function signature mismatch

- [ ] **Step 3: Update script path functions to accept client_id**

In `crates/nession-agent/src/tmux/manager.rs`, find the script path functions (around line 7-17):

```rust
fn source_script_path(session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-source-{session}-{safe}"))
}

fn unsource_script_path(session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-unsource-{session}-{safe}"))
}
```

Update to:

```rust
fn source_script_path(client_id: &str, session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-source-{client_id}-{session}-{safe}"))
}

fn unsource_script_path(client_id: &str, session: &str, name: &str) -> PathBuf {
    let safe = name.replace(['/', '\\'], "_");
    PathBuf::from(format!("/tmp/nession-unsource-{client_id}-{session}-{safe}"))
}
```

- [ ] **Step 4: Update source_env to accept and use client_id**

Find the `source_env` method (around line 118):

```rust
pub async fn source_env(
    &self,
    session_name: &str,
    env_name: &str,
    vars: &[(String, String)],
) -> Result<()> {
    let path = source_script_path(session_name, env_name);
```

Update to:

```rust
pub async fn source_env(
    &self,
    client_id: &str,
    session_name: &str,
    env_name: &str,
    vars: &[(String, String)],
) -> Result<()> {
    let path = source_script_path(client_id, session_name, env_name);
```

- [ ] **Step 5: Update unsource_env to accept and use client_id**

Find the `unsource_env` method (around line 142):

```rust
pub async fn unsource_env(
    &self,
    session_name: &str,
    env_name: &str,
    keys: &[String],
) -> Result<()> {
    let path = unsource_script_path(session_name, env_name);
```

Update to:

```rust
pub async fn unsource_env(
    &self,
    client_id: &str,
    session_name: &str,
    env_name: &str,
    keys: &[String],
) -> Result<()> {
    let path = unsource_script_path(client_id, session_name, env_name);
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cargo test -p nession-agent tmux::manager::tests::test_script_paths_include_client_id
```

Expected: PASS

- [ ] **Step 7: Add cleanup_client_scripts method**

In the `impl TmuxManager` block, after the `cleanup_session_scripts` method (around line 206), add:

```rust
/// Remove all env source/unsource scripts from `/tmp/` for the given
/// client. Called when a client disconnects so that only that client's
/// sourced envs are cleaned up, leaving other clients' scripts intact.
async fn cleanup_client_scripts(&self, client_id: &str) {
    let source_prefix = format!("nession-source-{client_id}-");
    let unsource_prefix = format!("nession-unsource-{client_id}-");
    let mut dir = match tokio::fs::read_dir("/tmp").await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(
                "failed to read /tmp for env script cleanup (client {client_id}): {e}"
            );
            return;
        }
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with(&source_prefix) || name_str.starts_with(&unsource_prefix) {
            let path = entry.path();
            if let Err(e) = tokio::fs::remove_file(&path).await {
                tracing::warn!("failed to remove env script {}: {e}", path.display());
            }
        }
    }
}
```

- [ ] **Step 8: Make cleanup_client_scripts public**

Change the method signature from:

```rust
async fn cleanup_client_scripts(&self, client_id: &str) {
```

to:

```rust
pub async fn cleanup_client_scripts(&self, client_id: &str) {
```

- [ ] **Step 9: Write test for cleanup_client_scripts**

Add to the `tests` module:

```rust
#[tokio::test]
async fn test_cleanup_client_scripts_only_removes_matching_client() {
    let manager = TmuxManager::new();
    
    // Create test scripts for two different clients
    let client1_script = source_script_path("client-1", "session-x", "staging");
    let client2_script = source_script_path("client-2", "session-x", "prod");
    
    tokio::fs::write(&client1_script, "export TEST=1").await.unwrap();
    tokio::fs::write(&client2_script, "export TEST=2").await.unwrap();
    
    // Cleanup client-1's scripts
    manager.cleanup_client_scripts("client-1").await;
    
    // Verify client-1's script is gone, client-2's remains
    assert!(!tokio::fs::metadata(&client1_script).await.is_ok());
    assert!(tokio::fs::metadata(&client2_script).await.is_ok());
    
    // Cleanup
    let _ = tokio::fs::remove_file(&client2_script).await;
}
```

- [ ] **Step 10: Run all TmuxManager tests**

```bash
cargo test -p nession-agent tmux::manager
```

Expected: All tests pass

- [ ] **Step 11: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "feat(agent): per-client env script paths and cleanup

Update source_env/unsource_env to accept client_id parameter.
Script paths now include client_id: /tmp/nession-{source,unsource}-{client_id}-{session}-{env}

Add cleanup_client_scripts method to remove only a specific client's
scripts on disconnect, leaving other clients' scripts intact.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Agent WebSocket — Track client_id Per Connection

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs:636-650,708-720,964-970`

- [ ] **Step 1: Add client_id tracking to connection state**

In `crates/nession-agent/src/server/websocket.rs`, find the `handle_connection` function (around line 602). After the `sessions` HashMap is created (around line 637-638):

```rust
// Per-client attached PTY sessions keyed by session name.
let sessions: Arc<Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>> =
    Arc::new(Mutex::new(std::collections::HashMap::new()));
```

Add client_id tracking:

```rust
// Per-client attached PTY sessions keyed by session name.
let sessions: Arc<Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>> =
    Arc::new(Mutex::new(std::collections::HashMap::new()));

// Client ID for this connection (assigned during auth)
let client_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
```

- [ ] **Step 2: Pass client_id to run_message_loop**

Update the `run_message_loop` call (around line 640-650) to pass `client_id`:

```rust
Self::run_message_loop(
    ws_stream,
    sink,
    tmux_manager,
    sessions,
    client_id,  // NEW
    addr,
    default_working_dir,
    file_ops,
    listen_address,
    agent_id,
)
.await
```

- [ ] **Step 3: Update run_message_loop signature**

Find the `run_message_loop` function (around line 656) and add the `client_id` parameter:

```rust
async fn run_message_loop(
    mut ws_stream: futures_util::stream::SplitStream<WebSocketStream<TcpOrTls>>,
    sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
    tmux: Arc<TmuxManager>,
    sessions: Arc<Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>>,
    client_id: Arc<Mutex<Option<String>>>,  // NEW
    addr: SocketAddr,
    default_working_dir: String,
    file_ops: Arc<FileOps>,
    listen_address: &str,
    agent_id: &str,
) -> Result<()> {
```

- [ ] **Step 4: Pass client_id to handle_request**

Update the `handle_request` call inside `run_message_loop` (around line 678-687):

```rust
let response = Self::handle_request(
    &text,
    tmux.clone(),
    sessions.clone(),
    client_id.clone(),  // NEW
    sink.clone(),
    &default_working_dir,
    file_ops.clone(),
    listen_address,
    agent_id,
)
.await;
```

- [ ] **Step 5: Update handle_request signature**

Find the `handle_request` function (around line 724) and add the `client_id` parameter:

```rust
async fn handle_request(
    text: &str,
    tmux: Arc<TmuxManager>,
    sessions: Arc<Mutex<std::collections::HashMap<String, crate::tmux::pty::PtySession>>>,
    client_id: Arc<Mutex<Option<String>>>,  // NEW
    sink: Arc<Mutex<futures_util::stream::SplitSink<WebSocketStream<TcpOrTls>, WsMessage>>>,
    default_working_dir: &str,
    file_ops: Arc<FileOps>,
    listen_address: &str,
    agent_id: &str,
) -> String {
```

- [ ] **Step 6: Update CLIENT_AUTH handler to assign client_id**

Find the `CLIENT_AUTH` handler (around line 964-970):

```rust
msg_types::CLIENT_AUTH => {
    let resp = AuthResponsePayload {
        status: "success".to_string(),
        message: "ok".to_string(),
    };
    serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
}
```

Update to:

```rust
msg_types::CLIENT_AUTH => {
    let payload: ClientAuthPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    
    // Assign client_id: use provided one or generate new UUID
    let assigned_client_id = payload.client_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    
    // Store in connection state
    {
        let mut cid = client_id.lock().await;
        *cid = Some(assigned_client_id.clone());
    }
    
    let resp = AuthResponsePayload {
        status: "success".to_string(),
        message: "ok".to_string(),
        client_id: assigned_client_id,
    };
    serde_json::to_string(&make_response(&id, msg_types::OK, resp)).unwrap_or_default()
}
```

- [ ] **Step 7: Cleanup on WebSocket close**

Find the cleanup code in `run_message_loop` (around line 708-716):

```rust
// Close any PTY sessions that were attached through this
// connection so that the underlying tmux attach children are
// terminated promptly.
let mut sessions_guard = sessions.lock().await;
for (name, session) in sessions_guard.drain() {
    if let Err(e) = session.close().await {
        warn!("Error closing PTY session {}: {:#}", name, e);
    }
}
```

Add client script cleanup:

```rust
// Close any PTY sessions that were attached through this
// connection so that the underlying tmux attach children are
// terminated promptly.
let mut sessions_guard = sessions.lock().await;
for (name, session) in sessions_guard.drain() {
    if let Err(e) = session.close().await {
        warn!("Error closing PTY session {}: {:#}", name, e);
    }
}

// Cleanup env scripts for this client
if let Some(cid) = client_id.lock().await.as_ref() {
    tmux.cleanup_client_scripts(cid).await;
}
```

- [ ] **Step 8: Verify compilation**

```bash
cargo check -p nession-agent
```

Expected: Compiles successfully (but will have errors at call sites — we'll fix those in Task 4)

- [ ] **Step 9: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs
git commit -m "feat(agent): track client_id per connection and cleanup on disconnect

Store client_id in connection state during auth. On WebSocket close,
cleanup only that client's env scripts, leaving other clients' intact.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Fix Call Sites — Pass client_id to source_env/unsource_env

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs:673,705`

- [ ] **Step 1: Update server.session.env.apply handler**

Open `crates/nession-agent/src/connection/server_client.rs`, find the `server.session.env.apply` handler (around line 658-692). The call to `source_env` is at line 673:

```rust
if let Err(e) = self
    .tmux
    .source_env(&payload.name, &snap.name, &snap.vars)
    .await
{
```

This is called from the server connection (not a client WebSocket), so we need to get the client_id from the message or use a default. For now, let's add client_id to the payload. First, update the call to use a placeholder:

```rust
// TODO: Get client_id from payload or context
let client_id = payload.client_id.as_deref().unwrap_or("server");
if let Err(e) = self
    .tmux
    .source_env(client_id, &payload.name, &snap.name, &snap.vars)
    .await
{
```

- [ ] **Step 2: Update server.session.env.unset handler**

Find the `server.session.env.unset` handler (around line 693-721). The call to `unsource_env` is at line 705:

```rust
if let Err(e) = self
    .tmux
    .unsource_env(&payload.name, "all", &payload.keys)
    .await
{
```

Update similarly:

```rust
let client_id = payload.client_id.as_deref().unwrap_or("server");
if let Err(e) = self
    .tmux
    .unsource_env(client_id, &payload.name, "all", &payload.keys)
    .await
{
```

- [ ] **Step 3: Add client_id to ServerSessionEnvApplyPayload**

Open `crates/nession-common/src/protocol.rs`, find `ServerSessionEnvApplyPayload` (search for it). Add the client_id field:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvApplyPayload {
    pub request_id: String,
    pub name: String,
    pub snapshots: Vec<EnvSnapshot>,
    #[serde(default)]
    pub client_id: Option<String>,  // NEW
}
```

- [ ] **Step 4: Add client_id to ServerSessionEnvUnsetPayload**

Find `ServerSessionEnvUnsetPayload` and add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionEnvUnsetPayload {
    pub request_id: String,
    pub name: String,
    pub keys: Vec<String>,
    #[serde(default)]
    pub client_id: Option<String>,  // NEW
}
```

- [ ] **Step 5: Verify compilation**

```bash
cargo check -p nession-agent
```

Expected: Compiles successfully

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs crates/nession-common/src/protocol.rs
git commit -m "feat(agent): pass client_id to source_env/unsource_env from server messages

Server can now specify client_id in env.apply/env.unset messages.
Falls back to 'server' if not provided for backward compatibility.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Web UI — Generate and Persist client_id

**Files:**
- Modify: `web/src/services/websocket.ts`

- [ ] **Step 1: Read the current websocket service**

Open `web/src/services/websocket.ts` and read it to understand the connection flow.

- [ ] **Step 2: Add client_id generation and persistence**

Find where the WebSocket connection is established. Add client_id logic before the connection:

```typescript
// Generate or retrieve persistent client_id
const getClientId = (): string => {
  const stored = localStorage.getItem('nession_client_id');
  if (stored) return stored;
  const newId = crypto.randomUUID();
  localStorage.setItem('nession_client_id', newId);
  return newId;
};
```

- [ ] **Step 3: Send client_id in auth message**

Find where the `client.auth` message is sent. Update it to include client_id:

```typescript
const clientId = getClientId();
const authMessage = {
  msg_type: 'client.auth',
  id: crypto.randomUUID(),
  timestamp: Date.now(),
  payload: {
    auth_token: token,
    client_id: clientId,  // NEW
  },
};
ws.send(JSON.stringify(authMessage));
```

- [ ] **Step 4: Handle client_id in auth response**

Find where the auth response is handled. Store the returned client_id:

```typescript
if (data.payload.status === 'success') {
  // Store the assigned client_id (in case we didn't send one)
  if (data.payload.client_id) {
    localStorage.setItem('nession_client_id', data.payload.client_id);
  }
  // ... rest of success handling
}
```

- [ ] **Step 5: Test the build**

```bash
cd web && npm run build
```

Expected: Builds successfully

- [ ] **Step 6: Commit**

```bash
git add web/src/services/websocket.ts
git commit -m "feat(web): generate and persist client_id for per-client env tracking

Generate UUID client_id on first connection, persist in localStorage.
Send client_id in auth message so agent can track per-client envs.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: CLI — Generate and Persist client_id

**Files:**
- Modify: `crates/nession-cli/src/client/connection.rs`

- [ ] **Step 1: Read the current connection code**

Open `crates/nession-cli/src/client/connection.rs` and understand the connection flow.

- [ ] **Step 2: Add client_id persistence functions**

Add helper functions to read/write client_id:

```rust
use std::path::PathBuf;

fn client_id_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".nession");
    path.push("cli");
    path.push("client_id");
    path
}

fn read_client_id() -> Option<String> {
    std::fs::read_to_string(client_id_path()).ok()
}

fn write_client_id(id: &str) -> std::io::Result<()> {
    let path = client_id_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, id)
}

fn get_or_create_client_id() -> String {
    if let Some(id) = read_client_id() {
        return id;
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = write_client_id(&id) {
        eprintln!("Warning: failed to persist client_id: {}", e);
    }
    id
}
```

- [ ] **Step 3: Use client_id in connection**

Find where the connection is established and the auth message is sent. Update to include client_id:

```rust
let client_id = get_or_create_client_id();
let auth_message = serde_json::json!({
    "msg_type": "client.auth",
    "id": uuid::Uuid::new_v4().to_string(),
    "timestamp": chrono::Utc::now().timestamp(),
    "payload": {
        "auth_token": token,
        "client_id": client_id,
    }
});
```

- [ ] **Step 4: Verify compilation**

```bash
cargo check -p nession-cli
```

Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add crates/nession-cli/src/client/connection.rs
git commit -m "feat(cli): generate and persist client_id for per-client env tracking

Generate UUID client_id on first run, persist in ~/.nession/cli/client_id.
Send client_id in auth message so agent can track per-client envs.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Integration Test — Multi-Client Scenario

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs` (add test)

- [ ] **Step 1: Write multi-client integration test**

Add to the `tests` module in `crates/nession-agent/src/server/websocket.rs`:

```rust
#[tokio::test]
async fn test_multi_client_env_isolation() {
    use crate::tmux::manager::TmuxManager;
    
    let tmux = TmuxManager::new();
    let session_name = "test-multi-client";
    
    // Setup: create session
    let _ = tmux.kill_session(session_name).await;
    tmux.create_session(session_name, 80, 24, "/tmp", &[]).await.unwrap();
    
    // Client A sources env
    let vars_a = vec![("VAR_A".to_string(), "value_a".to_string())];
    tmux.source_env("client-a", session_name, "env-a", &vars_a).await.unwrap();
    
    // Client B sources env
    let vars_b = vec![("VAR_B".to_string(), "value_b".to_string())];
    tmux.source_env("client-b", session_name, "env-b", &vars_b).await.unwrap();
    
    // Verify both scripts exist
    let script_a = std::path::PathBuf::from("/tmp/nession-source-client-a-test-multi-client-env-a");
    let script_b = std::path::PathBuf::from("/tmp/nession-source-client-b-test-multi-client-env-b");
    assert!(tokio::fs::metadata(&script_a).await.is_ok());
    assert!(tokio::fs::metadata(&script_b).await.is_ok());
    
    // Client A disconnects → cleanup only A's scripts
    tmux.cleanup_client_scripts("client-a").await;
    
    // Verify A's script is gone, B's remains
    assert!(!tokio::fs::metadata(&script_a).await.is_ok());
    assert!(tokio::fs::metadata(&script_b).await.is_ok());
    
    // Cleanup
    tmux.kill_session(session_name).await.ok();
}
```

- [ ] **Step 2: Run the test**

```bash
cargo test -p nession-agent server::websocket::tests::test_multi_client_env_isolation
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs
git commit -m "test(agent): add multi-client env isolation integration test

Verify that detaching one client only cleans up that client's env
scripts, leaving other clients' scripts intact.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Final Verification and Cleanup

- [ ] **Step 1: Run all tests**

```bash
cargo test --workspace
```

Expected: All tests pass

- [ ] **Step 2: Run clippy**

```bash
cargo clippy --workspace -- -D warnings
```

Expected: No warnings

- [ ] **Step 3: Run format check**

```bash
cargo fmt --all -- --check
```

Expected: No formatting issues

- [ ] **Step 4: Build web UI**

```bash
cd web && npm run build
```

Expected: Builds successfully

- [ ] **Step 5: Create summary commit**

```bash
git add -A
git commit -m "feat: per-client env file tracking implementation complete

- Protocol: client_id field in auth messages
- Agent: per-client script paths, cleanup on disconnect
- Web UI: generate/persist client_id in localStorage
- CLI: generate/persist client_id in ~/.nession/cli/client_id
- Tests: multi-client isolation verified

Closes #<issue-number>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: Manual testing checklist**

Document manual testing steps:

```
Manual Testing Checklist:

1. Start server + agent:
   cargo run -p nession-server
   cargo run -p nession-agent -- agent-config.toml

2. Start web UI:
   cd web && npm run dev

3. Open two browser windows (different client_ids):
   Window A: http://localhost:13000
   Window B: http://localhost:13000 (incognito or clear localStorage first)

4. In both windows:
   - Attach to same tmux session
   - Source different env files via EnvPanel
   - Verify both envs are active in the session

5. Close Window A:
   - Verify Window A's env scripts are cleaned up
   - Verify Window B's env scripts remain
   - Verify Window B's envs still work

6. Kill the session:
   - Verify all env scripts are cleaned up
```

---

## Execution Instructions

**Use subagent-driven development:**

1. Dispatch Task 1 to a subagent
2. Review the changes
3. Dispatch Task 2 to a subagent
4. Review the changes
5. Continue for all tasks
6. Run final verification

Each task is self-contained and can be implemented independently. Tasks 1-4 are backend, Task 5 is web UI, Task 6 is CLI, Task 7 is testing.

**Key points for subagents:**
- Follow TDD: write failing test first, then implement
- Run tests after each change
- Commit frequently with descriptive messages
- If stuck, refer to the spec at `docs/superpowers/specs/2026-07-15-per-attach-env-tracking-design.md`
