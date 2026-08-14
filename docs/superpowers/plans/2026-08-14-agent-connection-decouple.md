# Agent Connection Decouple + tmux Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the agent's single `tokio::select!` connection loop so a slow/hung tmux command can never block heartbeats or the reading of other server messages, and add timeout protection to every tmux subprocess call.

**Architecture:** Keep the sink owned by *one* loop (no `SplitSink` sharing), but move server-command handling (`handle_server_message`) into per-message `tokio::spawn` tasks whose responses return over an internal unbounded channel that the loop drains to the socket. `ServerClient` becomes `Arc`-wrapped so handlers can be spawned with `'static` lifetime. tmux subprocess calls in `SessionManager` get a `tmux_output`/`tmux_status` timeout wrapper (list=2s, kill=5s, create=10s).

**Tech Stack:** Rust (tokio, tokio-tungstenite, anyhow), existing `SessionManager`/`ServerClient` in `nession-agent`. No new dependencies.

**Reference issue:** #239 (Requirements finalized; this plan resolves its "Open Question" — timeout values).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `crates/nession-agent/src/tmux/manager.rs` | Timeout consts, `tmux_bin`+timeout fields, `tmux_output`/`tmux_status` helpers, timeout wrapping for `list_sessions`/`get_session_cwd`/`kill_session`/`create_session`, test seams (`with_tmux_bin`/`with_timeouts`) |
| `crates/nession-agent/src/connection/server_client.rs` | `Arc<Self>` supervisor, 4-branch `run_connection` loop with response channel, `handle_server_message` signature change (sink → responses channel) |
| `crates/nession-agent/src/tmux/manager.rs` (`#[cfg(test)]`) | Timeout-helper unit tests (via `sleep`), `list_sessions` timeout test (via fake tmux shim) |
| `crates/nession-agent/src/connection/server_client.rs` (`#[cfg(test)]`) | Decoupling integration tests: heartbeat flows while tmux hangs; `sessions.list` responds while `create` is slow |

**Design decisions (timeout values — the issue's open question):**

| Constant | Value | Rationale |
|----------|-------|-----------|
| `TMUX_LIST_TIMEOUT` | 2s | `list-sessions`/`display-message` are quick queries; must finish < server's `SESSION_REFRESH_TIMEOUT` (3s) so force-refresh never reports stale on a slow-but-completing list. |
| `TMUX_KILL_TIMEOUT` | 5s | `kill-session` is one quick command; generous bound that still fails fast. |
| `TMUX_CREATE_TIMEOUT` | 10s | `create_session` is multi-stage (~15 subcommands); accommodates slow CI while bounding a hang. |

---

## Task 1: Timeout infrastructure in `SessionManager`

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs`

- [ ] **Step 1: Add imports, consts, and struct fields**

Add `use std::time::Duration;` to the existing imports (top of file, after `use std::path::PathBuf;`).

Add the three consts right below `SESSION_HEIGHT`:

```rust
/// Timeout for quick tmux queries (`list-sessions`, `display-message`).
/// Must stay below the server's 3s force-refresh window so a slow list still
/// answers before the server marks the agent stale.
const TMUX_LIST_TIMEOUT: Duration = Duration::from_secs(2);

/// Timeout for `kill-session`.
const TMUX_KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for the multi-stage `create_session` (new-session + env setup).
const TMUX_CREATE_TIMEOUT: Duration = Duration::from_secs(10);
```

Change the struct (currently `struct SessionManager { env: EnvManager }`) to:

```rust
pub struct SessionManager {
    env: EnvManager,
    /// tmux binary name or path. Injectable so tests can substitute a fake.
    tmux_bin: String,
    list_timeout: Duration,
    kill_timeout: Duration,
    create_timeout: Duration,
}
```

- [ ] **Step 2: Update constructors and add helpers + test seams**

Replace `new()` and `with_script_dir()` bodies:

```rust
    pub fn new() -> Self {
        Self {
            env: EnvManager::new(std::env::temp_dir()),
            tmux_bin: "tmux".to_string(),
            list_timeout: TMUX_LIST_TIMEOUT,
            kill_timeout: TMUX_KILL_TIMEOUT,
            create_timeout: TMUX_CREATE_TIMEOUT,
        }
    }

    pub fn with_script_dir(script_dir: PathBuf) -> Self {
        Self {
            env: EnvManager::new(script_dir),
            ..Self::new()
        }
    }

    /// Test seam: override the tmux binary (inject a fake `tmux`).
    #[cfg(test)]
    pub(crate) fn with_tmux_bin(&mut self, tmux_bin: impl Into<String>) -> &mut Self {
        self.tmux_bin = tmux_bin.into();
        self
    }

    /// Test seam: override per-command timeouts for fast, deterministic tests.
    #[cfg(test)]
    pub(crate) fn with_timeouts(
        &mut self,
        list: Duration,
        kill: Duration,
        create: Duration,
    ) -> &mut Self {
        self.list_timeout = list;
        self.kill_timeout = kill;
        self.create_timeout = create;
        self
    }
```

Add two free helper functions (below the `impl Default` block, before `#[cfg(test)]`):

```rust
/// Run a tmux command, failing with a timeout error if it exceeds `timeout`.
async fn tmux_output(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output> {
    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => Err(anyhow::anyhow!("tmux command timed out after {timeout:?}")),
        Ok(res) => Ok(res?),
    }
}

/// Run a tmux command that only needs its exit status, with a timeout.
async fn tmux_status(cmd: &mut Command, timeout: Duration) -> Result<std::process::ExitStatus> {
    match tokio::time::timeout(timeout, cmd.status()).await {
        Err(_) => Err(anyhow::anyhow!("tmux command timed out after {timeout:?}")),
        Ok(res) => Ok(res?),
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p nession-agent`
Expected: compiles (helpers are not yet used — clippy will flag dead_code in a later step; proceed).

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "test: add tmux timeout infrastructure and test seams"
```

---

## Task 2: Apply timeouts to tmux subprocess calls

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs`

- [ ] **Step 1: `list_sessions` — use `tmux_bin` + timeout**

Replace the command construction in `list_sessions`:

```rust
        let output = Command::new("tmux")
            .args([
                "list-sessions",
                "-F",
                // Use | (pipe) as delimiter. Tmux converts tab characters (0x09)
                // in -F format strings to underscores (0x5F), so \t is unusable.
                "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{window_width}|#{window_height}",
            ])
            .output()
            .await?;
```

with:

```rust
        let mut cmd = Command::new(&self.tmux_bin);
        cmd.args([
            "list-sessions",
            "-F",
            // Use | (pipe) as delimiter. Tmux converts tab characters (0x09)
            // in -F format strings to underscores (0x5F), so \t is unusable.
            "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{window_width}|#{window_height}",
        ]);
        let output = tmux_output(&mut cmd, self.list_timeout).await?;
```

- [ ] **Step 2: `get_session_cwd` — use `tmux_bin` + timeout**

Replace:

```rust
        let output = Command::new("tmux")
            .args([
                "display-message",
                "-p",
                "-t",
                session_name,
                "-F",
                "#{pane_current_path}",
            ])
            .output()
            .await?;
```

with:

```rust
        let mut cmd = Command::new(&self.tmux_bin);
        cmd.args([
            "display-message",
            "-p",
            "-t",
            session_name,
            "-F",
            "#{pane_current_path}",
        ]);
        let output = tmux_output(&mut cmd, self.list_timeout).await?;
```

- [ ] **Step 3: `kill_session` — use `tmux_bin` + timeout**

Replace:

```rust
        let status = Command::new("tmux")
            .args(["kill-session", "-t", name])
            .stderr(std::process::Stdio::null())
            .status()
            .await?;
```

with:

```rust
        let mut cmd = Command::new(&self.tmux_bin);
        cmd.args(["kill-session", "-t", name])
            .stderr(std::process::Stdio::null());
        let status = tmux_status(&mut cmd, self.kill_timeout).await?;
```

- [ ] **Step 4: `create_session` — split into wrapper + impl, use `tmux_bin`**

Rename the existing `pub async fn create_session` to `async fn create_session_impl` (keep its signature; the `_width`/`_height` underscore names stay). Add the public wrapper above it:

```rust
    pub async fn create_session(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        match tokio::time::timeout(
            self.create_timeout,
            self.create_session_impl(name, width, height, working_dir, env),
        )
        .await
        {
            Err(_) => Err(anyhow::anyhow!(
                "tmux create-session timed out after {:?}",
                self.create_timeout
            )),
            Ok(inner) => inner,
        }
    }

    async fn create_session_impl(
        &self,
        name: &str,
        _width: u16,
        _height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
```

Inside `create_session_impl`, replace every `Command::new("tmux")` with `Command::new(&self.tmux_bin)`. There are **seven** occurrences: two `new-session` (`cmd`, `cmd2`), one `send-keys`, one `clear-history`, two `set-environment`, one `set-option`. (Do a global replace within this function.)

- [ ] **Step 5: Build + clippy**

Run: `cargo clippy -p nession-agent -- -D warnings`
Expected: 0 warnings (helpers now used).

- [ ] **Step 6: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "fix: add timeout protection to tmux subprocess calls"
```

---

## Task 3: Decouple `run_connection` into independent tasks

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs`

- [ ] **Step 1: Wrap `self` in `Arc` inside `supervise`**

At the very top of `supervise` (before the `let mut reconnect_delay` line), add:

```rust
        let this = Arc::new(self);
```

Replace the two remaining `self.` uses in `supervise`:
- `match self.connect_once().await {` → `match this.connect_once().await {`
- `let outcome = self.run_connection(sink, stream, &mut outbox_rx, &mut shutdown_rx).await;` →
  `let outcome = this.clone().run_connection(sink, stream, &mut outbox_rx, &mut shutdown_rx).await;`

- [ ] **Step 2: Rewrite `run_connection`**

Replace the entire current `run_connection` body (the single `select!` loop) with:

```rust
    /// Service a live connection: forward queued outgoing messages, handle
    /// incoming server messages, respond to pings, and watch for shutdown.
    ///
    /// Incoming server commands are handled in independently spawned tasks so a
    /// slow or hung tmux command never blocks the outbox (heartbeats) or the
    /// reading of subsequent messages. Command responses are returned over an
    /// internal channel and written to the socket by this loop — the sink is
    /// never shared across tasks.
    ///
    /// Returns whether the loop ended due to shutdown or a dropped connection.
    async fn run_connection(
        self: Arc<Self>,
        mut sink: WsSink,
        mut stream: WsStreamHalf,
        outbox_rx: &mut mpsc::UnboundedReceiver<WsMessage>,
        shutdown_rx: &mut mpsc::Receiver<()>,
    ) -> ConnectionOutcome {
        // Handler tasks write their responses here; this loop drains the channel
        // onto the socket. Unbounded so a handler never blocks on a full queue.
        let (resp_tx, mut resp_rx) = mpsc::unbounded_channel::<WsMessage>();

        loop {
            tokio::select! {
                // Outgoing: drain the outbox (heartbeats, session updates).
                outgoing = outbox_rx.recv() => {
                    match outgoing {
                        Some(msg) => {
                            if let Err(e) = sink.send(msg).await {
                                warn!("Failed to send to server: {:#}", e);
                                return ConnectionOutcome::Disconnected;
                            }
                        }
                        None => {
                            // Outbox closed: handle dropped, treat as shutdown.
                            return ConnectionOutcome::Shutdown;
                        }
                    }
                }
                // Command responses from handler tasks.
                response = resp_rx.recv() => {
                    match response {
                        Some(msg) => {
                            if let Err(e) = sink.send(msg).await {
                                warn!("Failed to send to server: {:#}", e);
                                return ConnectionOutcome::Disconnected;
                            }
                        }
                        None => {
                            // Unreachable while this loop holds a `resp_tx` clone;
                            // kept as a defensive disconnect.
                            return ConnectionOutcome::Disconnected;
                        }
                    }
                }
                // Incoming: server messages, pings, close.
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(WsMessage::Text(text))) => {
                            // Handle off the loop so a slow command can't block
                            // heartbeats or subsequent reads.
                            let this = self.clone();
                            let tx = resp_tx.clone();
                            tokio::spawn(async move {
                                if let Err(e) = this.handle_server_message(&text, &tx).await {
                                    warn!("Error handling server message: {:#}", e);
                                }
                            });
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            let _ = sink.send(WsMessage::Pong(data)).await;
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            info!("Server closed connection");
                            return ConnectionOutcome::Disconnected;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            error!("WebSocket error: {:#}", e);
                            return ConnectionOutcome::Disconnected;
                        }
                        None => {
                            info!("WebSocket stream ended");
                            return ConnectionOutcome::Disconnected;
                        }
                    }
                }
                // Shutdown: close the socket and stop the supervisor.
                _ = shutdown_rx.recv() => {
                    info!("Shutdown signal received");
                    let _ = sink.send(WsMessage::Close(None)).await;
                    return ConnectionOutcome::Shutdown;
                }
            }
        }
    }
```

- [ ] **Step 3: Build to confirm the signature wiring compiles**

Run: `cargo build -p nession-agent`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs
git commit -m "refactor: decouple agent connection send and command handling"
```

---

## Task 4: Route `handle_server_message` responses over the channel

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs`

- [ ] **Step 1: Change the signature**

Replace:

```rust
    async fn handle_server_message(&self, text: &str, sink: &mut WsSink) -> Result<()> {
```

with:

```rust
    async fn handle_server_message(
        &self,
        text: &str,
        responses: &mpsc::UnboundedSender<WsMessage>,
    ) -> Result<()> {
```

- [ ] **Step 2: Replace every response write**

Across `handle_server_message` (including the extension-dispatch block), replace each:

```rust
sink.send(WsMessage::Text(response.to_string())).await?;
```

with:

```rust
responses.send(WsMessage::Text(response.to_string()))?;
```

There are **nine** occurrences (extension dispatch + session.create + env.list/get/write/delete + session.env.apply/unset + env.query + session.kill + sessions.list). The `?` still works because `mpsc::SendError<WsMessage>` implements `std::error::Error`.

- [ ] **Step 3: Make the sessions.list timeout observable**

Replace this line in the `SERVER_SESSIONS_LIST` arm:

```rust
                let sessions = self.tmux.list_sessions().await.unwrap_or_default();
```

with:

```rust
                // An empty list is a legitimate answer, but a timeout/error is
                // observable here via the warning so a hung tmux isn't silent.
                let sessions = match self.tmux.list_sessions().await {
                    Ok(s) => s,
                    Err(e) => {
                        warn!("tmux list-sessions failed: {:#}", e);
                        vec![]
                    }
                };
```

- [ ] **Step 4: Build + clippy**

Run: `cargo clippy -p nession-agent -- -D warnings`
Expected: 0 warnings. (This confirms `mpsc::UnboundedSender` is in scope via the existing `use tokio::sync::mpsc;`.)

- [ ] **Step 5: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs
git commit -m "refactor: route server command responses over the response channel"
```

---

## Task 5: Unit tests for the timeout helpers

**Files:**
- Modify: `crates/nession-agent/src/tmux/manager.rs` (append to `#[cfg(test)] mod window_size_lock_tests`)

- [ ] **Step 1: Write the failing tests**

Add to `mod window_size_lock_tests` (which already has `use super::*;`):

```rust
    #[tokio::test]
    async fn tmux_output_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let start = std::time::Instant::now();
        let res = tmux_output(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn tmux_status_times_out() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let res = tmux_status(&mut cmd, Duration::from_millis(100)).await;
        assert!(res.is_err(), "expected timeout error, got {res:?}");
    }
```

(These use `sleep` — a real hanging process — so no tmux dependency. `Command` and `Duration` are in scope via `use super::*`.)

- [ ] **Step 2: Run to confirm they pass**

Run: `cargo test -p nession-agent tmux_output_times_out tmux_status_times_out`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/tmux/manager.rs
git commit -m "test: unit-test tmux timeout helpers"
```

---

## Task 6: Decoupling integration tests (heartbeat flows while hung; list responds while create slow)

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs` (append to `#[cfg(test)] mod tests`)

- [ ] **Step 1: Add the fake-tmux shim helper**

Append to `mod tests` (before the first new test):

```rust
    /// Write an executable `tmux` shim script that dispatches on `$1`.
    #[cfg(unix)]
    fn write_fake_tmux(dir: &std::path::Path, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("tmux");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path.to_string_lossy().into_owned()
    }
```

- [ ] **Step 2: Write the failing test — heartbeat flows while tmux hangs**

Add:

```rust
    /// A hung `list-sessions` (30s timeout, 5s actual hang) must not block a
    /// heartbeat from reaching the server. This fails on the pre-refactor
    /// single-select loop, which inline-awaits `list_sessions`.
    #[cfg(unix)]
    #[tokio::test]
    async fn heartbeat_flows_while_tmux_command_hangs() {
        let port = 28095;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("list-started");
        let shim = write_fake_tmux(
            dir.path(),
            &format!(
                "case \"$1\" in list-sessions) touch {}; sleep 5;; *) exit 0;; esac",
                marker.display()
            ),
        );

        let tmux = {
            let mut m = SessionManager::new();
            m.with_tmux_bin(shim).with_timeouts(
                Duration::from_secs(30),
                Duration::from_secs(5),
                Duration::from_secs(10),
            );
            Arc::new(m)
        };

        let (server_handle, mut msg_rx) = start_mock_server_sessions_list(port).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "test-agent-hang",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None,
            metadata_for_tests(),
            tmux,
            "/tmp".to_string(),
            None,
        );
        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // Wait until the agent has actually started the hung list-sessions call.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !marker.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(marker.exists(), "agent never started the hung tmux command");

        // Send a heartbeat while list-sessions is still sleeping.
        handle
            .send_heartbeat(AgentStatus::Online, 1, 0, 0, [0.0, 0.0, 0.0])
            .await
            .unwrap();

        // The heartbeat must arrive promptly (well before the 5s hang ends).
        let delivered = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let msg = msg_rx.recv().await.expect("server closed");
                let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
                if parsed["msg_type"] == "agent.heartbeat" {
                    return;
                }
            }
        })
        .await;
        assert!(
            delivered.is_ok(),
            "heartbeat was blocked by the hung tmux command"
        );

        handle.shutdown().await.ok();
        server_handle.abort();
    }
```

- [ ] **Step 3: Add a `metadata_for_tests()` helper (avoids repeating the struct)**

Add near the other test helpers in `mod tests`:

```rust
    fn metadata_for_tests() -> AgentMetadata {
        AgentMetadata {
            tmux_version: "3.3".to_string(),
            os_version: "Linux".to_string(),
            nession_version: "0.1.0".to_string(),
            image_tag: "test".to_string(),
        }
    }
```

(Existing tests already build this struct inline; the new tests reuse this helper. `AgentMetadata` is already imported at the top of the file.)

- [ ] **Step 4: Run the new test to verify it fails on current code (TDD red)**

Run: `cargo test -p nession-agent heartbeat_flows_while_tmux_command_hangs`
Expected: FAIL — the heartbeat is blocked by the hung `list-sessions` (this test is written against the *decoupled* behavior; it will go green only after Tasks 3–4 land, which they already have in sequence). If you ran Tasks 1–4 first, this should already PASS.

- [ ] **Step 5: Write the second failing test — sessions.list responds while create is slow**

Add a combined mock server + test. First the mock server (near the other `start_mock_server_*` helpers):

```rust
    /// Mock server that sends `server.session.create` immediately followed by
    /// `server.sessions.list`, then forwards all client responses.
    async fn start_mock_server_create_then_list(
        port: u16,
        session_name: String,
    ) -> (tokio::task::JoinHandle<()>, mpsc::Receiver<String>) {
        let (msg_tx, msg_rx) = mpsc::channel(100);
        let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
            .await
            .expect("failed to bind mock server");

        let handle = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let ws = accept_async(stream).await.expect("failed to accept ws");
                let (mut sink, mut stream) = ws.split();

                let response = serde_json::json!({
                    "msg_type": "agent.register.response",
                    "id": "test-id",
                    "timestamp": 1234567890,
                    "payload": { "status": "accepted", "message": "ok" }
                });
                let _ = sink.send(WsMessage::Text(response.to_string())).await;
                let _ = stream.next().await; // skip registration

                let create_cmd = serde_json::json!({
                    "msg_type": "server.session.create",
                    "id": "cmd-create",
                    "timestamp": 1234567891,
                    "payload": {
                        "request_id": "req-create",
                        "name": session_name,
                        "width": 100,
                        "height": 30
                    }
                });
                let _ = sink.send(WsMessage::Text(create_cmd.to_string())).await;

                let list_cmd = serde_json::json!({
                    "msg_type": "server.sessions.list",
                    "id": "cmd-list",
                    "timestamp": 1234567892,
                    "payload": { "request_id": "req-list" }
                });
                let _ = sink.send(WsMessage::Text(list_cmd.to_string())).await;

                while let Some(Ok(msg)) = stream.next().await {
                    if let WsMessage::Text(text) = msg {
                        let _ = msg_tx.send(text.clone()).await;
                    }
                }
            }
        });

        (handle, msg_rx)
    }
```

Then the test:

```rust
    /// `server.sessions.list` must answer within the refresh window even while a
    /// slow-but-not-timed-out `server.session.create` is still in flight.
    #[cfg(unix)]
    #[tokio::test]
    async fn sessions_list_responds_while_create_is_slow() {
        let port = 28096;
        let dir = tempfile::tempdir().unwrap();
        // new-session is slow (2s, under the 10s create timeout); list is fast.
        let shim = write_fake_tmux(
            dir.path(),
            "case \"$1\" in new-session) sleep 2;; *) exit 0;; esac",
        );

        let tmux = {
            let mut m = SessionManager::new();
            m.with_tmux_bin(shim).with_timeouts(
                Duration::from_secs(30),
                Duration::from_secs(5),
                Duration::from_secs(10),
            );
            Arc::new(m)
        };

        let (server_handle, mut msg_rx) =
            start_mock_server_create_then_list(port, "slow-create-test".to_string()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let client = ServerClient::new(
            format!("ws://127.0.0.1:{}", port),
            "test-token",
            "test-agent-slow-create",
            "test-host",
            "127.0.0.1",
            8080,
            None,
            vec![],
            None,
            metadata_for_tests(),
            tmux,
            "/tmp".to_string(),
            None,
        );
        let (handle, _interval) = client.connect_and_run().await.expect("connect failed");

        // The sessions.list response must arrive before the 2s create finishes.
        let list_answered = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let msg = msg_rx.recv().await.expect("server closed");
                let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
                if parsed["payload"]["command"] == "sessions.list" {
                    return parsed;
                }
            }
        })
        .await;
        let parsed = list_answered.expect("sessions.list was blocked by the slow create");
        assert_eq!(parsed["payload"]["request_id"], "req-list");
        assert_eq!(parsed["payload"]["success"], true);

        handle.shutdown().await.ok();
        server_handle.abort();
    }
```

- [ ] **Step 6: Run both decoupling tests**

Run: `cargo test -p nession-agent heartbeat_flows_while_tmux_command_hangs sessions_list_responds_while_create_is_slow`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs
git commit -m "test: verify decoupling keeps heartbeats flowing and list responsive"
```

---

## Task 7: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Formatting**

Run: `cargo fmt --all -- --check`
Expected: clean (if not, `cargo fmt --all` and re-check).

- [ ] **Step 2: Clippy**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: 0 warnings. (The `#[cfg(target_os = "linux")]` blocks in `heartbeat.rs` are not linted on macOS; manually re-read them for platform-independent lint issues before pushing.)

- [ ] **Step 3: Full test suite**

Run: `cargo test`
Expected: 100% pass. Note the new `#[cfg(unix)]` tests run on macOS/Linux; they skip elsewhere.

- [ ] **Step 4: Coverage (threshold 80% for nession-agent)**

Run: `cargo tarpaulin --out Html --output-dir target/tarpaulin`
Expected: nession-agent ≥ 80%. If new `#[cfg(unix)]` branches lower coverage, add the missing unit tests rather than allowing the drop.

- [ ] **Step 5: Playwright functional verification (manual, for the PR body)**

Per project rules, this is a backend-only change (no WebUI surface) — Playwright browser verification is **not required**. Instead, document the local manual check in the PR body:
```bash
# In a local stack, simulate a hung tmux (PATH shim) and confirm via logs that
# heartbeats keep flowing and force-refresh doesn't mark the agent stale.
```
Screenshots are N/A (no UI change). State this explicitly in the PR body under **核心功能截图** to satisfy the template.

---

## Self-Review

**Spec coverage (issue #239):**
- Goal 1 (decouple send from receive+handle) → Task 3 (spawned handlers) + Task 4 (response channel). ✅
- Goal 2 (timeout all tmux subprocess calls) → Task 2. ✅
- Goal 3 (behavior unchanged: register/reconnect/sync/heartbeat) → `sync_needed`/`connected` AtomicBools untouched; outbox still owned by `supervise` via `&mut`. ✅
- Non-goal "server side unchanged" → no server edits. ✅
- Success criterion 1 (hung tmux → error + heartbeat still sent) → Task 5 (error) + Task 6 test A (heartbeat). ✅
- Success criterion 2 (list answers while create slow) → Task 6 test B. ✅
- Edge case "timeout observable, not silent" → Task 4 Step 3 (list warn) + create/kill already map `Err` → `success:false`. ✅
- Edge case "shutdown converges" → Task 3 (loop returns, spawned handlers settle via channel-send failure). ✅
- Edge case "reconnect sync_needed/connected atomicity" → unchanged AtomicBool, verified. ✅
- Edge case "outbox disconnected behavior unchanged" → outbox `&mut` ownership preserved (buffered messages survive reconnect). ✅
- Open question (timeout values) → resolved in the design table at top. ✅

**Placeholder scan:** no TBD/TODO; all code shown.

**Type consistency:** `tmux_output`/`tmux_status` used consistently; `with_tmux_bin`/`with_timeouts` return `&mut Self` (chaining via `let mut m`); `handle_server_message` new signature `(&self, &str, &mpsc::UnboundedSender<WsMessage>)` matches Task 3's `&tx` call site and Task 4's implementation.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-14-agent-connection-decouple.md`.**

Before execution, create an isolated worktree (project rule: never develop on `main` / an unrelated branch — the current branch is `chore/fix-deploy-watch-prod`):
```
EnterWorktree name: "fix/agent-connection-decouple"
```

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
