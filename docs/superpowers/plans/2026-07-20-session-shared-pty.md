# Session-Shared PTY Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share one PtySession per tmux session — first attach creates it, subsequent attaches reuse it, last detach destroys it. Output is broadcast to all subscribed clients.

**Architecture:** Replace `HashMap<String, AttachedSession>` with `HashMap<String, SharedSession>`. A `SharedSession` holds one `PtySession` and a `Vec<UnboundedSender>`. The reader thread broadcasts to all senders. Input and resize go through the shared PtySession.

**Tech Stack:** Rust (agent only — web client unchanged)

---

## File Structure

- **Modify:** `crates/nession-agent/src/server/websocket.rs` — all session management logic

PtySession API unchanged. Control mode path unchanged.

---

## Task 1: Add SharedSession and replace SessionMap

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs:42-66`

- [ ] **Step 1: Replace `AttachedSession` and `SessionMap`**

Replace the `AttachedSession` enum (lines 42-63) and `SessionMap` type alias (line 66) with:

```rust
/// A plain PTY session shared by all attached clients.
/// Created on first attach, destroyed on last detach.
struct SharedSession {
    pty: crate::tmux::pty::PtySession,
    /// Unbounded senders — one per subscribed client.  The reader
    /// thread clones output to all of them.
    subscribers: Vec<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
}

/// Keep the control-mode variant for the `attach_mode = "control"` path.
enum AttachedSession {
    Shared(SharedSession),
    Control(crate::tmux::control::ControlModeSession),
}

impl AttachedSession {
    async fn write_input(&mut self, data: &[u8]) -> Result<()> {
        match self {
            AttachedSession::Shared(s) => s.pty.write(data),
            AttachedSession::Control(s) => s.write_input(data).await,
        }
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        match self {
            AttachedSession::Shared(s) => s.pty.resize(cols, rows),
            AttachedSession::Control(s) => s.resize(cols, rows).await,
        }
    }
}

type SessionMap = std::collections::HashMap<String, AttachedSession>;
```

- [ ] **Step 2: Verify compilation**

Run: `cargo build -p nession-agent`
Expected: Compiles (write_input and resize dispatch unchanged after rename)

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs
git commit -m "refactor(agent): add SharedSession for broadcast to multiple clients
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Rewrite CLIENT_ATTACH plain path for shared sessions

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs:945-1000` (CLIENT_ATTACH handler)

- [ ] **Step 1: Replace the plain PTY attach block**

Replace the current plain PTY branch (lines ~951-990) with:

```rust
if matches!(attach_mode, AttachMode::Plain) {
    let session_name = payload.session_name.clone();
    let mut sessions_guard = sessions.lock().await;

    if let Some(AttachedSession::Shared(shared)) = sessions_guard.get_mut(&session_name) {
        // ---- Session already exists: add new subscriber ----
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        shared.subscribers.push(tx);

        // Forward output to this new client only.
        let sink_output = Arc::clone(&sink);
        let session_name_output = session_name.clone();
        tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let output = TerminalOutputPayload {
                    session_name: session_name_output.clone(),
                    data: encoded,
                };
                let msg = new_message(msg_types::TERMINAL_OUTPUT, output);
                if let Ok(json) = serde_json::to_string(&msg) {
                    let mut s = sink_output.lock().await;
                    if s.send(WsMessage::Text(json)).await.is_err() {
                        break;
                    }
                }
            }
        });

        let resp = ClientAttachResponse { session_name };
        return serde_json::to_string(&make_response(&id, msg_types::OK, resp))
            .unwrap_or_default();
    }

    // ---- Session doesn't exist yet: create PtySession + first subscriber ----
    match crate::tmux::pty::PtySession::attach(
        &session_name,
        payload.width,
        payload.height,
    ) {
        Ok((mut pty_session, mut output_rx)) => {
            // Create the first subscriber.
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let shared = SharedSession {
                pty: pty_session,
                subscribers: vec![tx],
            };
            sessions_guard.insert(session_name.clone(), AttachedSession::Shared(shared));
            drop(sessions_guard);

            // Spawn ONE reader task that broadcasts to ALL subscribers.
            let sessions_clone = Arc::clone(&sessions);
            let session_name_clone = session_name.clone();
            tokio::spawn(async move {
                while let Some(bytes) = output_rx.recv().await {
                    let guard = sessions_clone.lock().await;
                    if let Some(AttachedSession::Shared(s)) = guard.get(&session_name_clone) {
                        // Broadcast to all subscribers; prune dead ones.
                        let encoded = base64::engine::general_purpose::STANDARD
                            .encode(&bytes);
                        s.subscribers.retain(|tx| tx.send(bytes.clone()).is_ok());
                        if s.subscribers.is_empty() {
                            break; // all clients gone, stop reading
                        }
                    } else {
                        break; // session removed
                    }
                }
            });

            let resp = ClientAttachResponse {
                session_name: payload.session_name,
            };
            serde_json::to_string(&make_response(&id, msg_types::OK, resp))
                .unwrap_or_default()
        }
        Err(e) => err("attach_failed", &e.to_string()),
    }
}
```

**Note:** The broadcast task reads from `output_rx` and sends to ALL subscribers. New subscribers (from subsequent attaches) get added to `subscribers` BEFORE the broadcast task processes the next chunk — so they receive fresh output immediately. Dead subscribers (channel closed) are pruned via `retain`.

- [ ] **Step 2: Verify compilation**

Run: `cargo build -p nession-agent`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs
git commit -m "feat(agent): share PtySession across multiple clients via broadcast
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Update CLIENT_DETACH and cleanup

**Files:**
- Modify: `crates/nession-agent/src/server/websocket.rs` — CLIENT_DETACH handler and cleanup

- [ ] **Step 1: Update CLIENT_DETACH for shared sessions**

Find the `CLIENT_DETACH` handler. Replace the `AttachedSession::Plain` branch in the match to handle `Shared`:

```rust
msg_types::CLIENT_DETACH => {
    let payload: ClientDetachPayload = match serde_json::from_value(payload_value) {
        Ok(p) => p,
        Err(e) => return err("parse_error", &e.to_string()),
    };
    let mut sessions_guard = sessions.lock().await;
    match sessions_guard.get_mut(&payload.session_name) {
        Some(session) => {
            match session {
                AttachedSession::Shared(shared) => {
                    // Shared session: the subscriber (this client) is
                    // removed by dropping its sender.  The PtySession
                    // stays alive as long as other subscribers remain.
                    // The broadcast task auto-prunes dead senders.
                    // If this was the last subscriber, remove the session
                    // so PtySession is dropped (child is killed).
                    shared.subscribers.retain(|tx| !tx.is_closed());
                    if shared.subscribers.is_empty() {
                        sessions_guard.remove(&payload.session_name);
                    }
                }
                AttachedSession::Control(mut s) => {
                    if let Err(e) = s.close().await {
                        warn!("Error closing control session {}: {:#}", payload.session_name, e);
                    }
                    sessions_guard.remove(&payload.session_name);
                }
            }
            let resp = ClientDetachResponse {
                session_name: payload.session_name,
            };
            serde_json::to_string(&make_ok(&id, &resp)).unwrap_or_default()
        }
        None => err(
            "not_attached",
            &format!("not attached to session: {}", payload.session_name),
        ),
    }
}
```

- [ ] **Step 2: Update the run_message_loop cleanup**

In `run_message_loop()`, the cleanup loop at lines ~818-830 drains all sessions. Update the `AttachedSession::Plain` match arm to `AttachedSession::Shared`:

```rust
let mut sessions_guard = sessions.lock().await;
for (name, session) in sessions_guard.drain() {
    match session {
        AttachedSession::Control(mut s) => {
            if let Err(e) = s.close().await {
                warn!("Error closing control session {}: {:#}", name, e);
            }
        }
        AttachedSession::Shared(s) => {
            // Drop the SharedSession — PtySession::Drop kills the child.
            drop(s);
        }
    }
}
```

- [ ] **Step 3: Verify compilation and tests**

Run: `cargo build -p nession-agent && cargo test -p nession-agent`
Expected: Compiles + all tests pass

- [ ] **Step 4: Commit**

```bash
git add crates/nession-agent/src/server/websocket.rs
git commit -m "fix(agent): handle shared PTY sessions in detach and cleanup
Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Manual verification

- [ ] **Step 1: Start local stack**

```bash
HOME=/tmp/nession-demo cargo run -p nession-server &
HOME=/tmp/nession-demo cargo run -p nession-agent -- agent-config.toml &
cd web && npm run dev
```

- [ ] **Step 2: Test multi-client shared session**

1. Browser tab 1: attach to session → verify content visible
2. Browser tab 2: attach to same session → verify SAME content visible
3. Type in tab 1 → verify tab 2 sees it
4. Type in tab 2 → verify tab 1 sees it

- [ ] **Step 3: Test resize**

1. Resize tab 1 → verify tmux reflows, tab 2 sees reflowed content
2. Resize tab 2 → verify same

- [ ] **Step 4: Test detach lifecycle**

1. Detach tab 1 → verify tab 2 still works
2. Detach tab 2 → verify PtySession cleaned up (no zombie processes)

---

## Summary

**Total tasks:** 4
**Estimated time:** 0.5-1 day
**Key change:** One `PtySession` per session, broadcast to all subscribers. PtySession API unchanged, control mode unchanged, web client unchanged.
