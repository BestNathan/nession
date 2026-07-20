# Relay Mode Attach — Implementation Design

**Status:** Draft
**Issue:** [#34](https://github.com/bestnathan/nession/issues/34)
**Date:** 2026-07-20

## 1. Summary

Fix relay mode terminal attach by:
1. Having the server inject `client.attach` (with env vars) before entering bidirectional forwarding
2. Unifying the browser→server relay path to use agent protocol format (`session_name`, base64)
3. Adding `client.detach` on graceful relay teardown
4. Adding `env_snapshots` to `ClientAttachPayload` so env vars are applied at PTY creation time

## 2. Gap Confirmation (from code review)

| Gap | Location | Root Cause |
|-----|----------|------------|
| **G1** No `client.attach` in relay | `server/websocket.rs:382` — `relay_bidirectional_via_channel()` | Connects to agent, starts forwarding, never sends `client.attach` |
| **G2** `session_id` vs `session_name` | `web/services/websocket.ts:477-493` — `sendTerminalInput()` | Payload field is `session_id`; agent expects `session_name` |
| **G3** Raw text vs base64 | `web/services/websocket.ts:477-493` — `sendTerminalInput()` | Sends raw `data` string; agent decodes base64 |
| **G4** No `client.detach` | `server/websocket.rs:524` — after `relay_bidirectional_via_channel` returns | Loop breaks, connection dropped; agent PTY cleaned up via Drop only |
| **G5** No env vars on attach | `agent/server/websocket.rs:197` — `ClientAttachPayload` | No `env_snapshots` field |
| **G6** Server protocol for relay I/O | `web/terminal/ConnectionManager.ts:71-72` — `send()` relay branch | Calls `sendTerminalInput(sessionId, data)` in server format |

## 3. Design

### 3.1 Message Flow (Relay Mode)

```
Browser                     Server                        Agent
  |                            |                            |
  |-- client.session.attach -->|                            |
  |   { session_id,            |                            |
  |     preferred_mode:relay,  |                            |
  |     env_snapshots? }       |                            |
  |                            |-- ws connect ------------->|
  |                            |-- client.attach ---------->|
  |                            |   { session_name,          |
  |                            |     width, height,         |
  |                            |     env_snapshots? }       |
  |                            |<-- ok ---------------------|
  |<-- attach response --------|   { session_name }         |
  |   { mode:relay,            |                            |
  |     session_name }         |                            |
  |                            |                            |
  |== RELAY ESTABLISHED ===================================|
  |                            |                            |
  |-- terminal.input --------->|-- terminal.input --------->|
  |   { session_name,          |   (forwarded as-is)        |
  |     data: base64 }         |                            |
  |                            |<-- terminal.output --------|
  |<-- terminal.output --------|   { session_name,          |
  |   (forwarded as-is)        |     data: base64 }         |
  |                            |                            |
  |== DISCONNECT ==========================================|
  |                            |                            |
  |   (ws to agent closes)     |-- client.detach ---------->|
  |                            |   { session_name }         |
  |                            |<-- ok ---------------------|
```

### 3.2 Protocol Changes

**nession-common `ClientSessionAttachPayload`:**
```rust
pub struct ClientSessionAttachPayload {
    pub session_id: String,
    pub preferred_mode: String,
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,  // NEW
}
```

**Agent `ClientAttachPayload`:**
```rust
pub struct ClientAttachPayload {
    pub session_name: String,
    pub width: u16,
    pub height: u16,
    #[serde(default)]
    pub env_snapshots: Vec<EnvSnapshot>,  // NEW
}
```

### 3.3 Server Changes

**`handler.rs` — `handle_client_session_attach`:**
- When `preferred_mode == "relay"`:
  1. Resolve env_snapshots from the request (reuse `resolve_snapshots`)
  2. Return `HandlerAction::Relay` with session_name and env_snapshots in context
  3. Relay action now carries `session_name` + `env_snapshots` (not just `agent_ws_url`)

**`handler.rs` — `HandlerAction::Relay`:**
```rust
Relay {
    agent_ws_url: String,
    session_id: String,
    session_name: String,       // NEW
    client_id: String,
    env_snapshots: Vec<EnvSnapshot>,  // NEW
}
```

**`websocket.rs` — `relay_bidirectional_via_channel`:**
- Accept `session_name` and `env_snapshots` parameters
- After connecting to agent WS, send `client.attach { session_name, width:80, height:24, env_snapshots }`
- Wait for `ok` response (timeout: 10s)
- On error, return error to client
- On any exit path, send `client.detach { session_name }` to agent (best-effort)

### 3.4 Agent Changes

**`server/websocket.rs` — `ClientAttachPayload`:**
- Add `env_snapshots: Vec<EnvSnapshot>` field with `#[serde(default)]`

**`server/websocket.rs` — `CLIENT_ATTACH` handler:**
- Before creating `PtySession::attach()`, call `tmux.set_environment()` for each env var
- Pass env vars as `&[(String, String)]` through the attach flow
- On attach failure, log warnings but continue (non-fatal)

### 3.5 Web UI Changes

**`WebSocketService` (websocket.ts) — new relay-specific methods:**
```typescript
sendRelayInput(sessionName: string, data: string): void {
  // base64-encode data, use session_name field
  const message = {
    msg_type: 'terminal.input',
    id: generateId(),
    timestamp: Date.now(),
    payload: { session_name: sessionName, data: encodeB64(data) },
  };
  this.ws!.send(JSON.stringify(message));
}

sendRelayResize(sessionName: string, cols: number, rows: number): void {
  const message = {
    msg_type: 'terminal.resize',
    id: generateId(),
    timestamp: Date.now(),
    payload: { session_name: sessionName, cols, rows },
  };
  this.ws!.send(JSON.stringify(message));
}
```

**`ConnectionManager.ts`:**
- `send()` relay branch: use `serverConnection.sendRelayInput(sessionName, data)` (base64, session_name)
- `sendResize()` relay branch: use `serverConnection.sendRelayResize(sessionName, cols, rows)` (session_name)
- `setupRelay()`: after reconnection, re-send `client.session.attach` with env_snapshots

**`types.ts`:**
- `AttachInfo` already has `session_name` — no change needed

### 3.6 Reconnection

When relay WebSocket drops:
1. `WebSocketService` auto-reconnects (existing)
2. On `authenticated` status, `ConnectionManager.setupRelay()` re-fires `attach()`
3. `attach()` calls `serverConnection.requestAttach(sessionId, 'relay')` — sends `client.session.attach`
4. Server reconnects to agent, re-sends `client.attach` with env_snapshots
5. Max 10 relay attempts (existing `RELAY_MAX_ATTEMPTS`)

### 3.7 Edge Cases

| Case | Behavior |
|------|----------|
| Empty env_snapshots | No `set-environment` calls; PTY created normally |
| Agent unreachable | Server returns error in attach response; browser shows toast |
| Session not found on agent | Agent returns `error { code: "attach_failed" }`; server forwards to browser |
| Connection drops mid-relay | Reconnection banner; server sends `client.detach` to agent; browser reconnects and re-attaches |
| Env var conflicts | Agent logs warning; tmux `set-environment` overwrites (last-wins) |
| Old agent (no env_snapshots field) | `#[serde(default)]` → empty vec; backward compatible |

## 4. Non-Goals (out of scope)

- P2P mode changes
- Env file CRUD (already in `feat/session-env-vars`)
- Performance optimization
- Security hardening
- Agent protocol version negotiation

## 5. Testing Strategy

### Unit Tests
- **Server handler:** `attach_relay_mode` test updated to verify env_snapshots in Relay action
- **Agent handler:** `test_client_attach_detach` updated with env_snapshots
- **Protocol:** serde round-trip for new fields with `#[serde(default)]`

### Integration Tests
- Relay attach with env_snapshots → verify `set-environment` called before PTY
- Relay attach without env_snapshots → verify backward compatible
- Relay detach → verify PTY cleaned up
- Session not found → verify error propagated

### Web Tests
- `ConnectionManager` relay send/sendResize → verify agent protocol format
- `WebSocketService` sendRelayInput → verify base64 encoding + session_name field

### Playwright Verification (mandatory)
- Start local stack, attach via relay mode, verify terminal output
- Verify env vars flow through to tmux session (`tmux show-environment`)
- Verify reconnection restores terminal
- Verify error toasts for: agent offline, session not found
