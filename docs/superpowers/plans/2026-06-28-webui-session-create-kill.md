# WebUI Session Create & Kill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable creating and destroying tmux sessions directly from the WebUI Dashboard, with commands flowing through Server → Agent via the bidirectional control connection.

**Architecture:** The Server's control connection (currently Agent→Server only) becomes bidirectional. A new `CommandBroker` on the Server bridges client requests to agent connections using oneshot channels for request/response correlation. The Agent's message loop is extended to handle `server.session.create` and `server.session.kill` commands from the Server. The WebUI gets two modals (create + kill confirmation) and new WebSocket service methods.

**Tech Stack:** Rust (tokio, tokio-tungstenite, serde), React 18 + TypeScript, xterm.js

---

## File Structure

### New Files
- `crates/nession-server/src/server/command_broker.rs` — CommandBroker + AgentControl
- `crates/nession-server/tests/command_broker_test.rs` — CommandBroker integration tests
- `crates/nession-server/tests/session_command_test.rs` — End-to-end server handler tests
- `crates/nession-agent/tests/command_handling_test.rs` — Agent command handling tests
- `web/src/components/CreateSessionModal.tsx` — Create session modal
- `web/src/components/ConfirmKillModal.tsx` — Kill confirmation modal

### Modified Files
- `crates/nession-common/src/protocol.rs` — New payload types
- `crates/nession-server/src/server/mod.rs` — Re-export command_broker
- `crates/nession-server/src/server/handler.rs` — New handlers, CommandBroker ref
- `crates/nession-server/src/server/websocket.rs` — Pass CommandBroker to handler
- `crates/nession-server/src/main.rs` — Create CommandBroker, pass to WebSocketServer
- `crates/nession-agent/src/connection/server_client.rs` — Handle server commands
- `crates/nession-agent/src/main.rs` — Pass TmuxManager to ServerClient
- `web/src/types.ts` — New TypeScript interfaces
- `web/src/services/websocket.ts` — createSession(), killSession() methods
- `web/src/components/Dashboard.tsx` — Integrate modals and buttons

---

### Task 1: Protocol Types (nession-common)

**Files:**
- Modify: `crates/nession-common/src/protocol.rs`

- [ ] **Step 1: Add new payload types to protocol.rs**

Add these types at the end of `crates/nession-common/src/protocol.rs`:

```rust
// --- Server → Agent command payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionCreatePayload {
    pub request_id: String,
    pub name: String,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSessionKillPayload {
    pub request_id: String,
    pub name: String,
}

fn default_width() -> u16 {
    80
}

fn default_height() -> u16 {
    24
}

// --- Agent → Server command response payload ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommandResponsePayload {
    pub request_id: String,
    pub command: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

// --- Client → Server session command payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCreatePayload {
    pub agent_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillPayload {
    pub session_id: String,
}

// --- Server → Client session command response payloads ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionCreateResponsePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientSessionKillResponsePayload {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
```

- [ ] **Step 2: Verify the crate compiles**

Run: `cd crates/nession-common && cargo check`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-common/src/protocol.rs
git commit -m "feat(common): add protocol types for session create/kill commands

Adds payload types for the bidirectional control connection:
- Server→Agent: ServerSessionCreatePayload, ServerSessionKillPayload
- Agent→Server: AgentCommandResponsePayload
- Client↔Server: ClientSessionCreate/Kill payloads and responses"
```

---

### Task 2: CommandBroker (nession-server)

**Files:**
- Create: `crates/nession-server/src/server/command_broker.rs`
- Create: `crates/nession-server/tests/command_broker_test.rs`
- Modify: `crates/nession-server/src/server/mod.rs`

- [ ] **Step 1: Write failing test for CommandBroker register and send_command**

Create `crates/nession-server/tests/command_broker_test.rs`:

```rust
use nession_server::server::command_broker::CommandBroker;
use std::sync::Arc;
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// A mock sink that captures sent messages instead of writing to a WebSocket.
struct MockSink {
    messages: Arc<Mutex<Vec<String>>>,
}

impl MockSink {
    fn new() -> (Self, Arc<Mutex<Vec<String>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        (Self { messages: messages.clone() }, messages)
    }
}

#[tokio::test]
async fn test_register_and_send_command() {
    let broker = CommandBroker::new();
    let (mock_sink, captured) = MockSink::new();
    let sink = Arc::new(Mutex::new(mock_sink));

    // Register an agent
    broker.register_agent("agent-1", sink.clone()).await;

    // Send a command
    let result = broker.send_command(
        "agent-1",
        "server.session.create",
        "req-1",
        serde_json::json!({"request_id": "req-1", "name": "test"}),
    );

    // The future should be pending (waiting for response)
    // Verify the message was "sent" to the mock sink
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let msgs = captured.lock().await;
    assert_eq!(msgs.len(), 1);
    let sent: serde_json::Value = serde_json::from_str(&msgs[0]).unwrap();
    assert_eq!(sent["msg_type"], "server.session.create");
    assert_eq!(sent["payload"]["request_id"], "req-1");
}

#[tokio::test]
async fn test_resolve_command() {
    let broker = CommandBroker::new();
    let (mock_sink, _captured) = MockSink::new();
    let sink = Arc::new(Mutex::new(mock_sink));

    broker.register_agent("agent-1", sink).await;

    // Send a command and get the receiver
    let rx = broker.send_command(
        "agent-1",
        "server.session.create",
        "req-1",
        serde_json::json!({"request_id": "req-1", "name": "test"}),
    );

    // Resolve the command
    let response = serde_json::json!({
        "request_id": "req-1",
        "command": "session.create",
        "success": true,
        "session_name": "test"
    });
    let resolved = broker.resolve_command("agent-1", "req-1", response).await;
    assert!(resolved, "should have found and resolved the pending command");

    // The receiver should now have the result
    let result = rx.await.unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["session_name"], "test");
}

#[tokio::test]
async fn test_unregister_agent_resolves_pending() {
    let broker = CommandBroker::new();
    let (mock_sink, _captured) = MockSink::new();
    let sink = Arc::new(Mutex::new(mock_sink));

    broker.register_agent("agent-1", sink).await;

    let rx = broker.send_command(
        "agent-1",
        "server.session.create",
        "req-1",
        serde_json::json!({"request_id": "req-1", "name": "test"}),
    );

    // Unregister the agent (simulates disconnect)
    broker.unregister_agent("agent-1").await;

    // The receiver should get an error (RecvError because sender was dropped)
    let result = rx.await;
    assert!(result.is_err(), "should fail when agent disconnects");
}

#[tokio::test]
async fn test_send_command_unknown_agent() {
    let broker = CommandBroker::new();

    let result = broker.send_command(
        "unknown-agent",
        "server.session.create",
        "req-1",
        serde_json::json!({}),
    );

    // Should get an immediate error since agent doesn't exist
    let rx_result = result.await;
    assert!(rx_result.is_err());
}
```

**Note:** The `MockSink` approach above uses a simple captured-messages pattern. The actual `CommandBroker` needs to be generic over sink types or use a trait. Since the real sink type is `SplitSink<WebSocketStream<...>>`, the `CommandBroker` will store `Arc<Mutex<dyn ...>>` or use a type alias. For the initial implementation, store the sink as `serde_json::Value` sender (the broker just serializes and the caller sends).

**Revised approach:** The `CommandBroker` stores a callback/closure for sending, not the raw WebSocket sink. This keeps it testable.

Revised `command_broker.rs` to match this test approach:

```rust
// This will be refined in Step 3 after seeing the test fail.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crates/nession-server && cargo test --test command_broker_test -- --nocapture 2>&1 | tail -5`
Expected: FAIL — "could not find `command_broker` in `server`"

- [ ] **Step 3: Implement CommandBroker**

Create `crates/nession-server/src/server/command_broker.rs`:

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, oneshot};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{warn, debug};

/// Type alias for the WebSocket sink write half.
/// We use a boxed trait object to avoid coupling to the concrete WebSocket stream type.
pub type WsSinkBox = Arc<Mutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>
    >,
    WsMessage,
>>>;

/// Per-agent control state: the writable sink and pending command receivers.
pub struct AgentControl {
    pub sink: WsSinkBox,
    pub pending_commands: HashMap<String, oneshot::Sender<serde_json::Value>>,
}

/// Bridges client requests to agent control connections.
///
/// Uses a nested map: agent_id → (request_id → oneshot::Sender).
/// When an agent disconnects, `unregister_agent` drops the inner map,
/// resolving all pending oneshots with `RecvError` automatically.
pub struct CommandBroker {
    agents: RwLock<HashMap<String, AgentControl>>,
}

impl CommandBroker {
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
        }
    }

    /// Register an agent's control connection sink.
    pub async fn register_agent(&self, agent_id: &str, sink: WsSinkBox) {
        let mut agents = self.agents.write().await;
        agents.insert(agent_id.to_string(), AgentControl {
            sink,
            pending_commands: HashMap::new(),
        });
        debug!("CommandBroker: registered agent {}", agent_id);
    }

    /// Remove an agent and resolve all its pending commands with errors.
    pub async fn unregister_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write().await;
        if agents.remove(agent_id).is_some() {
            debug!("CommandBroker: unregistered agent {}", agent_id);
        }
    }

    /// Send a command to an agent and return a oneshot receiver for the response.
    ///
    /// If the agent is not found, returns a receiver that immediately errors.
    pub async fn send_command(
        &self,
        agent_id: &str,
        msg_type: &str,
        request_id: &str,
        payload: serde_json::Value,
    ) -> oneshot::Receiver<serde_json::Value> {
        let (tx, rx) = oneshot::channel();

        let mut agents = self.agents.write().await;
        let agent = match agents.get_mut(agent_id) {
            Some(a) => a,
            None => {
                warn!("CommandBroker: agent {} not found", agent_id);
                // Return an already-closed sender so rx.await returns Err
                drop(tx);
                return rx;
            }
        };

        // Store the pending command
        agent.pending_commands.insert(request_id.to_string(), tx);

        // Build and send the message
        let msg = nession_common::protocol::Message {
            msg_type: msg_type.to_string(),
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            payload,
        };

        let json = match serde_json::to_string(&msg) {
            Ok(j) => j,
            Err(e) => {
                warn!("CommandBroker: failed to serialize command: {}", e);
                agent.pending_commands.remove(request_id);
                drop(tx);
                return rx;
            }
        };

        let sink = agent.sink.clone();
        drop(agents); // Release the write lock before awaiting the sink

        let req_id = request_id.to_string();
        let aid = agent_id.to_string();
        tokio::spawn(async move {
            use futures_util::SinkExt;
            let mut sink_lock = sink.lock().await;
            if let Err(e) = sink_lock.send(WsMessage::Text(json)).await {
                warn!("CommandBroker: failed to send command to agent {}: {}", aid, e);
                // The pending command will be cleaned up when the agent disconnects
                // or when the response handler tries to resolve it.
            } else {
                debug!("CommandBroker: sent {} to agent {} (req: {})", msg_type, aid, req_id);
            }
        });

        rx
    }

    /// Resolve a pending command with a response from the agent.
    /// Returns true if a pending command was found and resolved.
    pub async fn resolve_command(
        &self,
        agent_id: &str,
        request_id: &str,
        response: serde_json::Value,
    ) -> bool {
        let mut agents = self.agents.write().await;
        let agent = match agents.get_mut(agent_id) {
            Some(a) => a,
            None => return false,
        };

        if let Some(tx) = agent.pending_commands.remove(request_id) {
            let _ = tx.send(response);
            true
        } else {
            debug!(
                "CommandBroker: no pending command {} for agent {}",
                request_id, agent_id
            );
            false
        }
    }
}
```

- [ ] **Step 4: Update `mod.rs` to export command_broker**

Modify `crates/nession-server/src/server/mod.rs`:

```rust
mod websocket;
mod handler;
pub mod command_broker;

pub use websocket::WebSocketServer;
```

- [ ] **Step 5: Update tests to match the real WsSinkBox type**

The tests use a `MockSink` which won't match `WsSinkBox`. We need to adjust the test approach — instead of using the real `WsSinkBox` type, make the tests use a mock WebSocket server.

Replace `crates/nession-server/tests/command_broker_test.rs`:

```rust
use nession_server::server::command_broker::CommandBroker;
use std::sync::Arc;
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Start a mock agent WebSocket server and return (addr, captured messages receiver).
async fn start_mock_agent() -> (
    std::net::SocketAddr,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_clone = captured.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let (mut sink, mut stream) = ws.split();
            // Send a dummy register response so the connection is established
            let _ = sink.send(WsMessage::Text(serde_json::json!({
                "msg_type": "agent.register.response",
                "id": "test",
                "timestamp": 0,
                "payload": {"status": "accepted", "message": "ok"}
            }).to_string())).await;

            while let Some(Ok(WsMessage::Text(text))) = stream.next().await {
                captured_clone.lock().await.push(text);
                // Keep connection alive
            }
        }
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (addr, captured, handle)
}

#[tokio::test]
async fn test_register_and_send_command() {
    let (addr, captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    // Connect to the mock agent and register with broker
    let (ws_stream, _) = tokio_tungstenite::connect_async(
        format!("ws://{}", addr)
    ).await.unwrap();
    let (sink, _stream) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));

    broker.register_agent("agent-1", sink).await;

    // Send a command
    let _rx = broker.send_command(
        "agent-1",
        "server.session.create",
        "req-1",
        serde_json::json!({"request_id": "req-1", "name": "test", "width": 80, "height": 24}),
    ).await;

    // Wait for message to arrive at mock
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let msgs = captured.lock().await;
    assert_eq!(msgs.len(), 1);
    let sent: serde_json::Value = serde_json::from_str(&msgs[0]).unwrap();
    assert_eq!(sent["msg_type"], "server.session.create");
    assert_eq!(sent["payload"]["request_id"], "req-1");
    assert_eq!(sent["payload"]["name"], "test");
}

#[tokio::test]
async fn test_resolve_command() {
    let (addr, _captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(
        format!("ws://{}", addr)
    ).await.unwrap();
    let (sink, _stream) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));

    broker.register_agent("agent-1", sink).await;

    let rx = broker.send_command(
        "agent-1",
        "server.session.create",
        "req-1",
        serde_json::json!({"request_id": "req-1", "name": "test"}),
    ).await;

    // Resolve the command
    let response = serde_json::json!({
        "request_id": "req-1",
        "command": "session.create",
        "success": true,
        "session_name": "test"
    });
    let resolved = broker.resolve_command("agent-1", "req-1", response).await;
    assert!(resolved, "should have found and resolved the pending command");

    // The receiver should now have the result
    let result = rx.await.unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["session_name"], "test");
}

#[tokio::test]
async fn test_unregister_agent_resolves_pending() {
    let (addr, _captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(
        format!("ws://{}", addr)
    ).await.unwrap();
    let (sink, _stream) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));

    broker.register_agent("agent-1", sink).await;

    let rx = broker.send_command(
        "agent-1",
        "server.session.create",
        "req-1",
        serde_json::json!({"request_id": "req-1", "name": "test"}),
    ).await;

    // Unregister the agent (simulates disconnect)
    broker.unregister_agent("agent-1").await;

    // The receiver should get an error (RecvError because sender was dropped)
    let result = rx.await;
    assert!(result.is_err(), "should fail when agent disconnects");
}

#[tokio::test]
async fn test_send_command_unknown_agent() {
    let broker = CommandBroker::new();

    let rx = broker.send_command(
        "unknown-agent",
        "server.session.create",
        "req-1",
        serde_json::json!({}),
    ).await;

    // Should get an immediate error since agent doesn't exist (sender dropped)
    let result = rx.await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_multiple_concurrent_commands() {
    let (addr, captured, _handle) = start_mock_agent().await;
    let broker = CommandBroker::new();

    let (ws_stream, _) = tokio_tungstenite::connect_async(
        format!("ws://{}", addr)
    ).await.unwrap();
    let (sink, _stream) = ws_stream.split();
    let sink = Arc::new(Mutex::new(sink));

    broker.register_agent("agent-1", sink).await;

    let rx1 = broker.send_command(
        "agent-1", "server.session.create", "req-1",
        serde_json::json!({"request_id": "req-1", "name": "s1"}),
    ).await;

    let rx2 = broker.send_command(
        "agent-1", "server.session.create", "req-2",
        serde_json::json!({"request_id": "req-2", "name": "s2"}),
    ).await;

    // Resolve in reverse order
    broker.resolve_command("agent-1", "req-2", serde_json::json!({
        "request_id": "req-2", "command": "session.create", "success": true, "session_name": "s2"
    })).await;

    broker.resolve_command("agent-1", "req-1", serde_json::json!({
        "request_id": "req-1", "command": "session.create", "success": true, "session_name": "s1"
    })).await;

    let r1 = rx1.await.unwrap();
    let r2 = rx2.await.unwrap();
    assert_eq!(r1["session_name"], "s1");
    assert_eq!(r2["session_name"], "s2");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd crates/nession-server && cargo test --test command_broker_test -- --nocapture`
Expected: All 5 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/nession-server/src/server/command_broker.rs \
        crates/nession-server/src/server/mod.rs \
        crates/nession-server/tests/command_broker_test.rs
git commit -m "feat(server): add CommandBroker for bidirectional agent commands

The CommandBroker bridges client requests to agent control connections
using oneshot channels for request/response correlation. Supports
register/unregister agents, send commands, and resolve responses.
When an agent disconnects, all pending commands are automatically
resolved with errors."
```

---

### Task 3: Server Handlers for Session Create/Kill

**Files:**
- Modify: `crates/nession-server/src/server/handler.rs`

**Note:** Handler tests require full wiring (Task 4) to pass a CommandBroker through. Integration tests are in Task 5.

- [ ] **Step 1: Add CommandBroker and new handlers to ConnectionHandler**

Modify `crates/nession-server/src/server/handler.rs`.

Add `CommandBroker` to imports and struct:

```rust
use crate::server::command_broker::CommandBroker;
```

Add to `ConnectionHandler` struct:

```rust
pub struct ConnectionHandler {
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    server_auth_token: String,
    authenticated_client: bool,
    registered_agent_id: Option<String>,
}
```

Update `new`:

```rust
impl ConnectionHandler {
    pub fn new(
        agent_registry: Arc<AgentRegistry>,
        session_registry: Arc<SessionRegistry>,
        command_broker: Arc<CommandBroker>,
        server_auth_token: String,
    ) -> Self {
        Self {
            agent_registry,
            session_registry,
            command_broker,
            server_auth_token,
            authenticated_client: false,
            registered_agent_id: None,
        }
    }
```

Add new message types to `handle_protocol_message`:

```rust
    async fn handle_protocol_message(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        match msg.msg_type.as_str() {
            "agent.register" => self.handle_agent_register(msg).await,
            "agent.heartbeat" => self.handle_agent_heartbeat(msg).await,
            "agent.session.update" => self.handle_agent_session_update(msg).await,
            "agent.session.command.response" => self.handle_agent_command_response(msg).await,
            "client.auth" => self.handle_client_auth(msg).await,
            "client.agents.list" => self.handle_client_agents_list(msg).await,
            "client.sessions.list" => self.handle_client_sessions_list(msg).await,
            "client.session.attach" => self.handle_client_session_attach(msg).await,
            "client.session.create" => self.handle_client_session_create(msg).await,
            "client.session.kill" => self.handle_client_session_kill(msg).await,
            _ => {
                warn!("Unknown message type: {}", msg.msg_type);
                Ok(HandlerAction::Reply(None))
            }
        }
    }
```

Add the three new handler methods at the end of the `impl ConnectionHandler` block:

```rust
    /// Handle `client.session.create` — create a new session on a target agent.
    async fn handle_client_session_create(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.create.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Not authenticated"
                    }
                }).to_string()
            ))));
        }

        let agent_id = msg.payload["agent_id"].as_str().unwrap_or("");
        let name = msg.payload["name"].as_str().unwrap_or("");

        if agent_id.is_empty() || name.is_empty() {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.create.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "agent_id and name are required"
                    }
                }).to_string()
            ))));
        }

        // Check agent exists and is online
        let agent = self.agent_registry.get(agent_id).await;
        match agent {
            Some(a) if a.status == AgentStatus::Online => {}
            Some(_) => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": format!("Agent '{}' is offline", agent_id)
                        }
                    }).to_string()
                ))));
            }
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": format!("Agent '{}' not found", agent_id)
                        }
                    }).to_string()
                ))));
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        info!("Client requested session create on agent {}: name={}", agent_id, name);

        // Send command to agent via CommandBroker
        let rx = self.command_broker.send_command(
            agent_id,
            "server.session.create",
            &request_id,
            json!({
                "request_id": request_id,
                "name": name,
                "width": 80,
                "height": 24
            }),
        ).await;

        // Wait for agent response with timeout
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(response)) => {
                let success = response["success"].as_bool().unwrap_or(false);
                let session_id = if success {
                    Some(format!("{}:{}", agent_id, name))
                } else {
                    None
                };
                let error = response["error"].as_str().map(|s| s.to_string());

                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": success,
                            "session_id": session_id,
                            "error": error,
                        }
                    }).to_string()
                ))))
            }
            Ok(Err(_)) => {
                // Agent disconnected while waiting
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": "Agent disconnected"
                        }
                    }).to_string()
                ))))
            }
            Err(_) => {
                // Timeout
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.create.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": "Timeout waiting for agent response"
                        }
                    }).to_string()
                ))))
            }
        }
    }

    /// Handle `client.session.kill` — kill a session on its agent.
    async fn handle_client_session_kill(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        if !self.authenticated_client {
            return Ok(HandlerAction::Reply(Some(Message::Text(
                json!({
                    "msg_type": "client.session.kill.response",
                    "id": msg.id,
                    "timestamp": current_timestamp(),
                    "payload": {
                        "success": false,
                        "error": "Not authenticated"
                    }
                }).to_string()
            ))));
        }

        let session_id = msg.payload["session_id"].as_str().unwrap_or("");

        // Parse session_id as "agent_id:session_name"
        let (agent_id, session_name) = match session_id.split_once(':') {
            Some((aid, sname)) => (aid.to_string(), sname.to_string()),
            None => {
                return Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.kill.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": "Invalid session_id format. Expected 'agent_id:session_name'"
                        }
                    }).to_string()
                ))));
            }
        };

        // Check session exists in registry
        let session = self.session_registry.get(session_id).await;
        if session.is_none() {
            // Session not in registry — may have been removed already
            // Check if agent is offline; if so, just remove from registry and succeed
            let agent = self.agent_registry.get(&agent_id).await;
            match agent {
                Some(a) if a.status != AgentStatus::Online => {
                    self.session_registry.remove(session_id).await;
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.kill.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": {
                                "success": true
                            }
                        }).to_string()
                    ))));
                }
                Some(_) => {
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.kill.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": {
                                "success": false,
                                "error": format!("Session '{}' not found", session_id)
                            }
                        }).to_string()
                    ))));
                }
                None => {
                    return Ok(HandlerAction::Reply(Some(Message::Text(
                        json!({
                            "msg_type": "client.session.kill.response",
                            "id": msg.id,
                            "timestamp": current_timestamp(),
                            "payload": {
                                "success": false,
                                "error": format!("Agent '{}' not found", agent_id)
                            }
                        }).to_string()
                    ))));
                }
            }
        }

        let request_id = uuid::Uuid::new_v4().to_string();

        info!("Client requested session kill: {} (agent: {})", session_name, agent_id);

        let rx = self.command_broker.send_command(
            &agent_id,
            "server.session.kill",
            &request_id,
            json!({
                "request_id": request_id,
                "name": session_name,
            }),
        ).await;

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(response)) => {
                let success = response["success"].as_bool().unwrap_or(false);
                let error = response["error"].as_str().map(|s| s.to_string());

                // If successful, remove from session registry
                if success {
                    self.session_registry.remove(session_id).await;
                }

                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.kill.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": success,
                            "error": error,
                        }
                    }).to_string()
                ))))
            }
            Ok(Err(_)) => {
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.kill.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": "Agent disconnected"
                        }
                    }).to_string()
                ))))
            }
            Err(_) => {
                Ok(HandlerAction::Reply(Some(Message::Text(
                    json!({
                        "msg_type": "client.session.kill.response",
                        "id": msg.id,
                        "timestamp": current_timestamp(),
                        "payload": {
                            "success": false,
                            "error": "Timeout waiting for agent response"
                        }
                    }).to_string()
                ))))
            }
        }
    }

    /// Handle `agent.session.command.response` — resolve a pending command.
    async fn handle_agent_command_response(
        &mut self,
        msg: ProtocolMessage<serde_json::Value>,
    ) -> anyhow::Result<HandlerAction> {
        let agent_id = match &self.registered_agent_id {
            Some(id) => id.clone(),
            None => {
                warn!("agent.session.command.response from unregistered connection");
                return Ok(HandlerAction::Reply(None));
            }
        };

        let request_id = msg.payload["request_id"].as_str().unwrap_or("");
        if request_id.is_empty() {
            warn!("agent.session.command.response missing request_id");
            return Ok(HandlerAction::Reply(None));
        }

        info!(
            "Received command response from agent {}: request_id={}, command={}",
            agent_id,
            request_id,
            msg.payload["command"].as_str().unwrap_or("unknown")
        );

        self.command_broker
            .resolve_command(&agent_id, request_id, msg.payload)
            .await;

        Ok(HandlerAction::Reply(None))
    }
```

Also need to add `use std::time::Duration;` at the top and ensure `Duration` is used in the timeout.

**Agent sink registration:** The handler returns `Reply(Some(response))` as before. The `websocket.rs` loop (in Task 4) checks `handler.registered_agent_id()` after each message — when a new agent_id appears, it registers the sink with CommandBroker. No new `HandlerAction` variant needed.

Add a public accessor for `registered_agent_id` (needed by `websocket.rs` in Task 4):

```rust
impl ConnectionHandler {
    /// Returns the agent_id if this connection has a registered agent.
    pub fn registered_agent_id(&self) -> Option<&String> {
        self.registered_agent_id.as_ref()
    }
}
```

- [ ] **Step 2: Compile check**

Run: `cd crates/nession-server && cargo check 2>&1 | tail -20`
Expected: Errors about missing imports, CommandBroker parameter, etc. Fix them.

- [ ] **Step 3: Commit handler changes**

```bash
git add crates/nession-server/src/server/handler.rs
git commit -m "feat(server): add handlers for client.session.create/kill

New handlers delegate to CommandBroker to send commands to agents
via the bidirectional control connection. Includes timeout handling,
agent offline detection, and session registry cleanup on kill."
```

---

### Task 4: Server Wiring — Connect CommandBroker to WebSocket Loop

**Files:**
- Modify: `crates/nession-server/src/server/websocket.rs`
- Modify: `crates/nession-server/src/server/mod.rs`
- Modify: `crates/nession-server/src/main.rs`

- [ ] **Step 1: Add CommandBroker to WebSocketServer struct**

In `crates/nession-server/src/server/websocket.rs`:

Add to imports:
```rust
use crate::server::command_broker::CommandBroker;
```

Add to struct:
```rust
pub struct WebSocketServer {
    config: ServerConfig,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    listener: Option<TcpListener>,
}
```

Update `new`:
```rust
pub async fn new(config: ServerConfig) -> anyhow::Result<Self> {
    let listener = TcpListener::bind(&config.listen_address).await?;
    let agent_registry = Arc::new(AgentRegistry::new(config.heartbeat_timeout_secs));
    let session_registry = Arc::new(SessionRegistry::new());
    let command_broker = Arc::new(CommandBroker::new());

    Ok(Self {
        config,
        agent_registry,
        session_registry,
        command_broker,
        listener: Some(listener),
    })
}
```

Add a getter:
```rust
pub fn command_broker(&self) -> Arc<CommandBroker> {
    Arc::clone(&self.command_broker)
}
```

- [ ] **Step 2: Pass CommandBroker through handle_connection → handle_ws_stream**

Update `run`:
```rust
let command_broker = Arc::clone(&self.command_broker);
// ... in the spawn:
if let Err(e) = handle_connection(
    tcp_stream,
    tls_acceptor,
    agent_registry,
    session_registry,
    command_broker,
    auth_token,
).await {
```

Update `handle_connection`:
```rust
async fn handle_connection(
    tcp_stream: tokio::net::TcpStream,
    tls_acceptor: Option<TlsAcceptor>,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    auth_token: String,
) -> anyhow::Result<()> {
    if let Some(acceptor) = tls_acceptor {
        let tls_stream = acceptor.accept(tcp_stream).await?;
        handle_ws_stream(tls_stream, agent_registry, session_registry, command_broker, auth_token).await
    } else {
        handle_ws_stream(tcp_stream, agent_registry, session_registry, command_broker, auth_token).await
    }
}
```

- [ ] **Step 3: Update handle_ws_stream to use CommandBroker**

```rust
async fn handle_ws_stream<S>(
    stream: S,
    agent_registry: Arc<AgentRegistry>,
    session_registry: Arc<SessionRegistry>,
    command_broker: Arc<CommandBroker>,
    auth_token: String,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let ws_stream = accept_async(stream).await?;
    let (write, mut read) = ws_stream.split();
    let mut handler = ConnectionHandler::new(
        agent_registry,
        session_registry,
        command_broker.clone(),
        auth_token,
    );

    use futures_util::StreamExt;
    use futures_util::SinkExt;

    // Wrap the write sink in Arc<Mutex> for CommandBroker registration
    let sink_arc = Arc::new(Mutex::new(write));

    while let Some(msg) = read.next().await {
        let msg = msg?;

        // Check if we need to register agent sink after handling
        let prev_agent_id = handler.registered_agent_id().cloned();

        let action = handler.handle_message(msg).await?;

        // If a new agent just registered, register its sink with CommandBroker
        let new_agent_id = handler.registered_agent_id().cloned();
        if new_agent_id.is_some() && new_agent_id != prev_agent_id {
            command_broker.register_agent(
                new_agent_id.as_ref().unwrap(),
                sink_arc.clone(),
            ).await;
        }

        match action {
            HandlerAction::Reply(Some(response)) => {
                let mut w = sink_arc.lock().await;
                w.send(response).await?;
            }
            HandlerAction::Reply(None) => {}
            HandlerAction::Relay { agent_ws_url } => {
                // For relay, we need to use the sink_arc
                // ... existing relay logic adapted for sink_arc
                break;
            }
            HandlerAction::Close => {
                break;
            }
        }
    }

    // Clean up: unregister agent from CommandBroker on disconnect
    if let Some(agent_id) = handler.registered_agent_id() {
        command_broker.unregister_agent(agent_id).await;
    }

    Ok(())
}
```

Note: Need to add `pub fn registered_agent_id(&self) -> Option<&String>` to `ConnectionHandler`.

Also need `use tokio::sync::Mutex;` in this file.

- [ ] **Step 4: Compile and fix errors**

Run: `cd crates/nession-server && cargo check 2>&1 | tail -30`
Fix any type mismatches or missing imports.

- [ ] **Step 5: Commit wiring changes**

```bash
git add crates/nession-server/src/server/websocket.rs \
        crates/nession-server/src/server/mod.rs
git commit -m "feat(server): wire CommandBroker into WebSocket connection lifecycle

- Pass CommandBroker through handle_connection → handle_ws_stream → handler
- Register agent sink with CommandBroker on successful agent.register
- Unregister agent sink on connection close (resolves pending commands)"
```

---

### Task 5: Server Integration Test

**Files:**
- Create: `crates/nession-server/tests/session_command_test.rs`

- [ ] **Step 1: Write end-to-end integration test**

This test starts a real server, connects a mock agent, connects a client, and exercises the create/kill flow:

```rust
//! Integration test: client → server → mock agent session create/kill flow.

use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use nession_server::server::WebSocketServer;
use nession_common::config::ServerConfig;

/// Start a real server on a random port.
async fn start_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let config = ServerConfig {
        listen_address: "127.0.0.1:0".to_string(),
        auth_token: "test".to_string(),
        heartbeat_timeout_secs: 60,
        tls_cert_path: String::new(),
        tls_key_path: String::new(),
        db_path: String::new(),
    };

    let mut server = WebSocketServer::new(config).await.unwrap();
    let addr = server.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;
    (addr, handle)
}

/// Connect a mock agent: register, then handle commands.
async fn connect_mock_agent(
    addr: std::net::SocketAddr,
    agent_id: &str,
) -> futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
> {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr)).await.unwrap();
    let (mut sink, mut stream) = ws.split();

    // Register
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-1",
        "timestamp": 0,
        "payload": {
            "agent_id": agent_id,
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": "test",
            "metadata": {"tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1.0"},
            "protocol_version": "1.0"
        }
    });
    sink.send(WsMessage::Text(reg.to_string())).await.unwrap();

    // Read register response
    let resp = stream.next().await.unwrap().unwrap();
    assert!(matches!(resp, WsMessage::Text(_)));

    sink
}

/// Handle one command from the server: read it, execute it, send response.
async fn handle_one_command(
    agent_sink: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WsMessage,
    >,
    agent_stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    success: bool,
) -> String {
    let msg = agent_stream.next().await.unwrap().unwrap();
    let text = match msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text message"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    let request_id = parsed["payload"]["request_id"].as_str().unwrap().to_string();
    let command = parsed["msg_type"].as_str().unwrap().to_string();

    let response = serde_json::json!({
        "msg_type": "agent.session.command.response",
        "id": uuid::Uuid::new_v4().to_string(),
        "timestamp": 0,
        "payload": {
            "request_id": request_id,
            "command": command.strip_prefix("server.").unwrap_or(&command),
            "success": success,
            "session_name": if success { parsed["payload"]["name"].as_str().unwrap_or("test") } else { null }
        }
    });
    agent_sink.send(WsMessage::Text(response.to_string())).await.unwrap();
    request_id
}

#[tokio::test]
async fn test_session_create_flow() {
    let (addr, _server_handle) = start_server().await;

    // Connect mock agent
    let (agent_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr)).await.unwrap();
    let (mut agent_sink, mut agent_stream) = agent_ws.split();

    // Register agent
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-1",
        "timestamp": 0,
        "payload": {
            "agent_id": "agent-1",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": "test",
            "metadata": {"tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1.0"},
            "protocol_version": "1.0"
        }
    });
    agent_sink.send(WsMessage::Text(reg.to_string())).await.unwrap();
    let _ = agent_stream.next().await; // register response

    // Connect client
    let (client_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr)).await.unwrap();
    let (mut client_sink, mut client_stream) = client_ws.split();

    // Authenticate
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": {"auth_token": "test"}
    });
    client_sink.send(WsMessage::Text(auth.to_string())).await.unwrap();
    let _ = client_stream.next().await; // auth response

    // Send session create
    let create = serde_json::json!({
        "msg_type": "client.session.create",
        "id": "create-1",
        "timestamp": 0,
        "payload": {"agent_id": "agent-1", "name": "my-session"}
    });
    client_sink.send(WsMessage::Text(create.to_string())).await.unwrap();

    // Agent receives the command
    let agent_msg = agent_stream.next().await.unwrap().unwrap();
    let agent_text = match agent_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let agent_parsed: serde_json::Value = serde_json::from_str(&agent_text).unwrap();
    assert_eq!(agent_parsed["msg_type"], "server.session.create");
    assert_eq!(agent_parsed["payload"]["name"], "my-session");
    let request_id = agent_parsed["payload"]["request_id"].as_str().unwrap();

    // Agent sends response
    let response = serde_json::json!({
        "msg_type": "agent.session.command.response",
        "id": "resp-1",
        "timestamp": 0,
        "payload": {
            "request_id": request_id,
            "command": "session.create",
            "success": true,
            "session_name": "my-session"
        }
    });
    agent_sink.send(WsMessage::Text(response.to_string())).await.unwrap();

    // Client receives the response
    let client_msg = client_stream.next().await.unwrap().unwrap();
    let client_text = match client_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let client_parsed: serde_json::Value = serde_json::from_str(&client_text).unwrap();
    assert_eq!(client_parsed["msg_type"], "client.session.create.response");
    assert_eq!(client_parsed["payload"]["success"], true);
    assert_eq!(client_parsed["payload"]["session_id"], "agent-1:my-session");
}

#[tokio::test]
async fn test_session_kill_flow() {
    let (addr, _server_handle) = start_server().await;

    // Connect mock agent
    let (agent_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr)).await.unwrap();
    let (mut agent_sink, mut agent_stream) = agent_ws.split();

    // Register agent
    let reg = serde_json::json!({
        "msg_type": "agent.register",
        "id": "reg-1",
        "timestamp": 0,
        "payload": {
            "agent_id": "agent-1",
            "hostname": "test-host",
            "ip_address": "127.0.0.1",
            "port": 19999,
            "auth_token": "test",
            "metadata": {"tmux_version": "3.3", "os_version": "Linux", "nession_version": "0.1.0"},
            "protocol_version": "1.0"
        }
    });
    agent_sink.send(WsMessage::Text(reg.to_string())).await.unwrap();
    let _ = agent_stream.next().await;

    // Connect & auth client
    let (client_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr)).await.unwrap();
    let (mut client_sink, mut client_stream) = client_ws.split();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": {"auth_token": "test"}
    });
    client_sink.send(WsMessage::Text(auth.to_string())).await.unwrap();
    let _ = client_stream.next().await;

    // We need a session in the registry first. Simulate by sending agent.session.update.
    let update = serde_json::json!({
        "msg_type": "agent.session.update",
        "id": "update-1",
        "timestamp": 0,
        "payload": {
            "agent_id": "agent-1",
            "session_name": "my-session",
            "status": "detached",
            "window_count": 1,
            "attached_clients": 0
        }
    });
    agent_sink.send(WsMessage::Text(update.to_string())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Send session kill
    let kill = serde_json::json!({
        "msg_type": "client.session.kill",
        "id": "kill-1",
        "timestamp": 0,
        "payload": {"session_id": "agent-1:my-session"}
    });
    client_sink.send(WsMessage::Text(kill.to_string())).await.unwrap();

    // Agent receives kill command
    let agent_msg = agent_stream.next().await.unwrap().unwrap();
    let agent_text = match agent_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let agent_parsed: serde_json::Value = serde_json::from_str(&agent_text).unwrap();
    assert_eq!(agent_parsed["msg_type"], "server.session.kill");
    assert_eq!(agent_parsed["payload"]["name"], "my-session");
    let request_id = agent_parsed["payload"]["request_id"].as_str().unwrap();

    // Agent sends success response
    let response = serde_json::json!({
        "msg_type": "agent.session.command.response",
        "id": "resp-1",
        "timestamp": 0,
        "payload": {
            "request_id": request_id,
            "command": "session.kill",
            "success": true
        }
    });
    agent_sink.send(WsMessage::Text(response.to_string())).await.unwrap();

    // Client receives response
    let client_msg = client_stream.next().await.unwrap().unwrap();
    let client_text = match client_msg {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let client_parsed: serde_json::Value = serde_json::from_str(&client_text).unwrap();
    assert_eq!(client_parsed["msg_type"], "client.session.kill.response");
    assert_eq!(client_parsed["payload"]["success"], true);
}

#[tokio::test]
async fn test_create_with_offline_agent_returns_error() {
    let (addr, _server_handle) = start_server().await;

    // Connect & auth client (no agent registered)
    let (client_ws, _) = tokio_tungstenite::connect_async(format!("ws://{}", addr)).await.unwrap();
    let (mut client_sink, mut client_stream) = client_ws.split();
    let auth = serde_json::json!({
        "msg_type": "client.auth",
        "id": "auth-1",
        "timestamp": 0,
        "payload": {"auth_token": "test"}
    });
    client_sink.send(WsMessage::Text(auth.to_string())).await.unwrap();
    let _ = client_stream.next().await;

    // Try to create session on non-existent agent
    let create = serde_json::json!({
        "msg_type": "client.session.create",
        "id": "create-1",
        "timestamp": 0,
        "payload": {"agent_id": "nonexistent", "name": "test"}
    });
    client_sink.send(WsMessage::Text(create.to_string())).await.unwrap();

    // Should get immediate error
    let resp = client_stream.next().await.unwrap().unwrap();
    let text = match resp {
        WsMessage::Text(t) => t,
        _ => panic!("expected text"),
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["msg_type"], "client.session.create.response");
    assert_eq!(parsed["payload"]["success"], false);
    assert!(parsed["payload"]["error"].as_str().unwrap().contains("not found"));
}
```

- [ ] **Step 2: Run the integration tests**

Run: `cd crates/nession-server && cargo test --test session_command_test -- --nocapture`
Expected: All 3 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/nession-server/tests/session_command_test.rs
git commit -m "test(server): add integration tests for session create/kill flow

Tests cover: successful create flow, successful kill flow, and
immediate error when target agent doesn't exist."
```

---

### Task 6: Agent Command Handling

**Files:**
- Modify: `crates/nession-agent/src/connection/server_client.rs`
- Modify: `crates/nession-agent/src/main.rs`

- [ ] **Step 1: Add TmuxManager parameter to ServerClient**

In `crates/nession-agent/src/connection/server_client.rs`:

Add import:
```rust
use crate::tmux::manager::TmuxManager;
```

Add `tmux` field to `ServerClient`:
```rust
pub struct ServerClient {
    // ... existing fields ...
    tmux: Arc<TmuxManager>,
}
```

Update `ServerClient::new`:
```rust
pub fn new(
    server_url: impl Into<String>,
    auth_token: impl Into<String>,
    agent_id: impl Into<String>,
    hostname: impl Into<String>,
    ip_address: impl Into<String>,
    port: u16,
    metadata: AgentMetadata,
    tmux: Arc<TmuxManager>,
) -> Self {
    // ... existing fields ...
    Self {
        // ...
        tmux,
    }
}
```

- [ ] **Step 2: Pass TmuxManager to run_message_loop and handle_server_message**

Update `try_connect` to pass `tmux`:
```rust
let tmux = self.tmux.clone();
tokio::spawn(async move {
    Self::run_message_loop(ws_stream, sink, shutdown_rx, agent_id, tmux).await;
});
```

Update `run_message_loop` signature:
```rust
async fn run_message_loop(
    mut ws_stream: WsStreamHalf,
    sink: Arc<Mutex<WsSink>>,
    mut shutdown_rx: mpsc::Receiver<()>,
    agent_id: String,
    tmux: Arc<TmuxManager>,
) {
```

Update the message handler call:
```rust
if let Err(e) = Self::handle_server_message(&text, &sink, &agent_id, &tmux).await {
```

- [ ] **Step 3: Extend handle_server_message to handle commands**

Update `handle_server_message` signature and add command handling:

```rust
async fn handle_server_message(
    text: &str,
    sink: &Arc<Mutex<WsSink>>,
    agent_id: &str,
    tmux: &TmuxManager,
) -> Result<()> {
    let msg: ProtocolMessage<serde_json::Value> = serde_json::from_str(text)
        .context("failed to parse server message")?;

    match msg.msg_type.as_str() {
        msg_types::AGENT_REGISTER_RESPONSE => {
            // ... existing logic ...
        }
        "server.session.create" => {
            let request_id = msg.payload["request_id"].as_str().unwrap_or("").to_string();
            let name = msg.payload["name"].as_str().unwrap_or("").to_string();
            let width = msg.payload["width"].as_u64().unwrap_or(80) as u16;
            let height = msg.payload["height"].as_u64().unwrap_or(24) as u16;

            info!("Server requested session create: name={}, width={}, height={}", name, width, height);

            let (success, error, session_name) = match tmux.create_session(&name, width, height).await {
                Ok(()) => (true, None, Some(name.clone())),
                Err(e) => (false, Some(e.to_string()), None),
            };

            let response = serde_json::json!({
                "msg_type": "agent.session.command.response",
                "id": uuid::Uuid::new_v4().to_string(),
                "timestamp": chrono::Utc::now().timestamp() as u64,
                "payload": {
                    "request_id": request_id,
                    "command": "session.create",
                    "success": success,
                    "error": error,
                    "session_name": session_name,
                }
            });

            let mut sink_lock = sink.lock().await;
            sink_lock.send(WsMessage::Text(response.to_string())).await?;
        }
        "server.session.kill" => {
            let request_id = msg.payload["request_id"].as_str().unwrap_or("").to_string();
            let name = msg.payload["name"].as_str().unwrap_or("").to_string();

            info!("Server requested session kill: name={}", name);

            let (success, error) = match tmux.kill_session(&name).await {
                Ok(()) => (true, None),
                Err(e) => (false, Some(e.to_string())),
            };

            let response = serde_json::json!({
                "msg_type": "agent.session.command.response",
                "id": uuid::Uuid::new_v4().to_string(),
                "timestamp": chrono::Utc::now().timestamp() as u64,
                "payload": {
                    "request_id": request_id,
                    "command": "session.kill",
                    "success": success,
                    "error": error,
                }
            });

            let mut sink_lock = sink.lock().await;
            sink_lock.send(WsMessage::Text(response.to_string())).await?;
        }
        _ => {
            debug!(
                "Received message from server: {} (id: {})",
                msg.msg_type, msg.id
            );
        }
    }

    Ok(())
}
```

- [ ] **Step 4: Update main.rs to pass TmuxManager to ServerClient**

In `crates/nession-agent/src/main.rs`:

Change the `ServerClient::new` call:

```rust
let tmux = TmuxManager::new();

// ... (check tmux availability) ...

let tmux_for_client = Arc::new(TmuxManager::new());
let server_client = ServerClient::new(
    &config.server_url,
    &config.auth_token,
    &config.agent_id,
    &hostname,
    &ip_address,
    port,
    metadata,
    tmux_for_client,
);
```

Add `use std::sync::Arc;` at the top of main.rs.

- [ ] **Step 5: Update existing tests that construct ServerClient**

The existing tests in `server_client.rs` construct `ServerClient::new` without the `tmux` parameter. Update them to pass `Arc::new(TmuxManager::new())`.

- [ ] **Step 6: Compile and run all tests**

Run: `cd crates/nession-agent && cargo test 2>&1 | tail -10`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/nession-agent/src/connection/server_client.rs \
        crates/nession-agent/src/main.rs
git commit -m "feat(agent): handle server.session.create/kill commands

The agent's control connection message loop now handles commands from
the server: creates and kills tmux sessions via TmuxManager and sends
responses back through the same connection."
```

---

### Task 7: WebUI Types and WebSocket Service

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/services/websocket.ts`

- [ ] **Step 1: Add TypeScript interfaces to types.ts**

Add to `web/src/types.ts`:

```typescript
export interface CreateSessionResponse {
  success: boolean;
  session_id?: string;
  error?: string;
}

export interface KillSessionResponse {
  success: boolean;
  error?: string;
}
```

- [ ] **Step 2: Add createSession and killSession methods to WebSocketService**

Add to `web/src/services/websocket.ts`, after the `requestAttach` method:

```typescript
async createSession(agentId: string, name: string): Promise<CreateSessionResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const response = await this.request<CreateSessionResponse>('client.session.create', {
      agent_id: agentId,
      name,
    });

    return response;
}

async killSession(sessionId: string): Promise<KillSessionResponse> {
    if (!this.authenticated) {
      throw new Error('Not authenticated');
    }

    const response = await this.request<KillSessionResponse>('client.session.kill', {
      session_id: sessionId,
    });

    return response;
}
```

Update the imports at the top of the file:

```typescript
import {
  WebSocketMessage,
  ConnectionStatus,
  Agent,
  Session,
  AttachInfo,
  AuthResponse,
  AgentsListResponse,
  SessionsListResponse,
  CreateSessionResponse,
  KillSessionResponse,
} from '../types';
```

- [ ] **Step 3: Verify the frontend compiles**

Run: `cd web && npm run build 2>&1 | tail -5`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/services/websocket.ts
git commit -m "feat(web): add createSession and killSession to WebSocket service

Adds TypeScript interfaces and WebSocket service methods for the
new client.session.create and client.session.kill protocol messages."
```

---

### Task 8: CreateSessionModal Component

**Files:**
- Create: `web/src/components/CreateSessionModal.tsx`

- [ ] **Step 1: Create the CreateSessionModal component**

Create `web/src/components/CreateSessionModal.tsx`:

```tsx
import { useState, useEffect, useRef } from 'react';
import type { Agent } from '../types';
import type { WebSocketService } from '../services/websocket';

interface CreateSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  agents: Agent[];
  preselectedAgentId?: string | null;
  onCreated: () => void;
}

export function CreateSessionModal({
  isOpen,
  onClose,
  wsService,
  agents,
  preselectedAgentId,
  onCreated,
}: CreateSessionModalProps) {
  const [agentId, setAgentId] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const onlineAgents = agents.filter((a) => a.status === 'online');

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setAgentId(preselectedAgentId ?? (onlineAgents.length > 0 ? onlineAgents[0].agent_id : ''));
      setSessionName('');
      setLoading(false);
      setError(null);
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [isOpen, preselectedAgentId]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const validateName = (name: string): string | null => {
    if (!name.trim()) return 'Session name is required';
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(name.trim())) {
      return 'Only letters, digits, underscores, hyphens, and dots allowed';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameError = validateName(sessionName);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!agentId) {
      setError('Please select an agent');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await wsService.createSession(agentId, sessionName.trim());
      if (result.success) {
        onCreated();
        onClose();
      } else {
        setError(result.error ?? 'Failed to create session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Create Session</h3>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label htmlFor="agent-select">Agent</label>
            <select
              id="agent-select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={loading}
            >
              {onlineAgents.map((agent) => (
                <option key={agent.agent_id} value={agent.agent_id}>
                  {agent.hostname} ({agent.agent_id})
                </option>
              ))}
            </select>
          </div>
          <div className="modal-field">
            <label htmlFor="session-name">Session Name</label>
            <input
              ref={nameInputRef}
              id="session-name"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="my-session"
              disabled={loading}
              autoComplete="off"
            />
          </div>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn-modal-confirm" disabled={loading || !agentId}>
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add modal styles to Dashboard.css**

Add to `web/src/components/Dashboard.css`:

```css
/* Modal styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: #1e1e2e;
  border: 1px solid #45475a;
  border-radius: 8px;
  padding: 24px;
  min-width: 360px;
  max-width: 480px;
  color: #cdd6f4;
}

.modal-title {
  margin: 0 0 16px;
  font-size: 18px;
  color: #cdd6f4;
}

.modal-field {
  margin-bottom: 12px;
}

.modal-field label {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
  color: #a6adc8;
}

.modal-field input,
.modal-field select {
  width: 100%;
  padding: 8px 12px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 4px;
  color: #cdd6f4;
  font-size: 14px;
  box-sizing: border-box;
}

.modal-field input:focus,
.modal-field select:focus {
  outline: none;
  border-color: #89b4fa;
}

.modal-field input:disabled,
.modal-field select:disabled {
  opacity: 0.6;
}

.modal-error {
  color: #f38ba8;
  font-size: 13px;
  margin: 8px 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.btn-modal-cancel {
  padding: 8px 16px;
  background: transparent;
  border: 1px solid #45475a;
  border-radius: 4px;
  color: #a6adc8;
  cursor: pointer;
  font-size: 14px;
}

.btn-modal-cancel:hover {
  background: #313244;
}

.btn-modal-confirm {
  padding: 8px 16px;
  background: #89b4fa;
  border: none;
  border-radius: 4px;
  color: #1e1e2e;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
}

.btn-modal-confirm:hover {
  background: #74c7ec;
}

.btn-modal-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd web && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/CreateSessionModal.tsx \
        web/src/components/Dashboard.css
git commit -m "feat(web): add CreateSessionModal component

Modal dialog with agent selection dropdown, session name input,
validation, loading states, and inline error display.
Uses Catppuccin dark theme consistent with existing UI."
```

---

### Task 9: ConfirmKillModal Component

**Files:**
- Create: `web/src/components/ConfirmKillModal.tsx`

- [ ] **Step 1: Create the ConfirmKillModal component**

Create `web/src/components/ConfirmKillModal.tsx`:

```tsx
import { useState, useEffect } from 'react';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';

interface ConfirmKillModalProps {
  isOpen: boolean;
  onClose: () => void;
  wsService: WebSocketService;
  session: Session | null;
  onKilled: () => void;
}

export function ConfirmKillModal({
  isOpen,
  onClose,
  wsService,
  session,
  onKilled,
}: ConfirmKillModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setLoading(false);
      setError(null);
    }
  }, [isOpen]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !session) return null;

  const handleConfirm = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await wsService.killSession(session.session_id);
      if (result.success) {
        onKilled();
        onClose();
      } else {
        setError(result.error ?? 'Failed to kill session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kill session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Kill Session</h3>
        <p className="modal-description">
          Are you sure you want to kill session{' '}
          <strong>{session.session_name}</strong> on agent{' '}
          <strong>{session.agent_id}</strong>?
        </p>
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn-modal-cancel" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-modal-confirm btn-modal-danger"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? 'Killing...' : 'Kill Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add danger button style to Dashboard.css**

Add to `web/src/components/Dashboard.css`:

```css
.btn-modal-danger {
  background: #f38ba8;
}

.btn-modal-danger:hover {
  background: #eba0ac;
}

.modal-description {
  color: #a6adc8;
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 16px;
}

.modal-description strong {
  color: #cdd6f4;
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd web && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ConfirmKillModal.tsx \
        web/src/components/Dashboard.css
git commit -m "feat(web): add ConfirmKillModal component

Confirmation dialog showing session name and agent, with inline
error display and loading state. Uses danger-styled confirm button."
```

---

### Task 10: Dashboard Integration

**Files:**
- Modify: `web/src/components/Dashboard.tsx`

- [ ] **Step 1: Import new components and add state**

Add imports at the top of `Dashboard.tsx`:

```tsx
import { CreateSessionModal } from './CreateSessionModal';
import { ConfirmKillModal } from './ConfirmKillModal';
```

Add state variables inside the `Dashboard` component:

```tsx
// Modal state
const [showCreateModal, setShowCreateModal] = useState(false);
const [sessionToKill, setSessionToKill] = useState<Session | null>(null);
```

- [ ] **Step 2: Add handler functions**

Add these callbacks inside the Dashboard component:

```tsx
const handleCreateSession = useCallback(() => {
  setShowCreateModal(true);
}, []);

const handleSessionCreated = useCallback(() => {
  // Session will appear via sessions.changed event, but refresh immediately too
  fetchSessions(selectedAgentId ?? undefined);
}, [fetchSessions, selectedAgentId]);

const handleKillClick = useCallback((session: Session) => {
  setSessionToKill(session);
}, []);

const handleSessionKilled = useCallback(() => {
  fetchSessions(selectedAgentId ?? undefined);
}, [fetchSessions, selectedAgentId]);
```

- [ ] **Step 3: Add Create Session button and Kill buttons to the JSX**

In the Sessions panel header, add a create button next to the refresh button:

```tsx
<div className="panel-header">
  <h2>
    Sessions
    {selectedAgentId && (
      <span className="filter-badge">
        {agents.find((a) => a.agent_id === selectedAgentId)?.hostname ?? selectedAgentId}
        <button className="filter-clear" onClick={() => setSelectedAgentId(null)} title="Clear filter">
          &times;
        </button>
      </span>
    )}
  </h2>
  <div className="panel-header-actions">
    <button
      className="btn-create-session"
      onClick={handleCreateSession}
      title="Create new session"
    >
      + Create
    </button>
    <button className="btn-refresh" onClick={handleRefreshSessions} disabled={loadingSessions} title="Refresh sessions">
      {loadingSessions ? '⟳' : '↻'}
    </button>
  </div>
</div>
```

In the session list items, add a Kill button:

```tsx
{filteredSessions.map((session) => (
  <li key={session.session_id} className="session-item">
    <span className={`status-dot status-${session.status === 'active' ? 'active' : 'detached'}`} />
    <div className="session-info">
      <span className="session-name">{session.session_name}</span>
      <span className="session-meta">
        {session.agent_id} &middot; {session.window_count} win &middot; {session.attached_clients} client
        {session.attached_clients !== 1 ? 's' : ''}
      </span>
    </div>
    <div className="session-actions">
      <button
        className="btn-attach"
        onClick={() => handleAttach(session)}
        disabled={attachingInProgress}
      >
        {attachingInProgress ? '...' : 'Attach'}
      </button>
      <button
        className="btn-kill"
        onClick={() => handleKillClick(session)}
        disabled={session.status === 'active' && session.attached_clients > 0}
        title={
          session.status === 'active' && session.attached_clients > 0
            ? 'Cannot kill: session has attached clients'
            : 'Kill session'
        }
      >
        Kill
      </button>
    </div>
  </li>
))}
```

- [ ] **Step 4: Add modals and create button style at the end of the return**

Before the closing `</div>` of the dashboard, add:

```tsx
{/* Modals */}
<CreateSessionModal
  isOpen={showCreateModal}
  onClose={() => setShowCreateModal(false)}
  wsService={wsService}
  agents={agents}
  preselectedAgentId={selectedAgentId}
  onCreated={handleSessionCreated}
/>
<ConfirmKillModal
  isOpen={sessionToKill !== null}
  onClose={() => setSessionToKill(null)}
  wsService={wsService}
  session={sessionToKill}
  onKilled={handleSessionKilled}
/>
```

- [ ] **Step 5: Add new styles to Dashboard.css**

Add to `web/src/components/Dashboard.css`:

```css
.panel-header-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.btn-create-session {
  padding: 4px 10px;
  background: #a6e3a1;
  border: none;
  border-radius: 4px;
  color: #1e1e2e;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.btn-create-session:hover {
  background: #94e2d5;
}

.session-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn-kill {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid #f38ba8;
  border-radius: 4px;
  color: #f38ba8;
  cursor: pointer;
  font-size: 12px;
}

.btn-kill:hover:not(:disabled) {
  background: rgba(243, 139, 168, 0.15);
}

.btn-kill:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
```

- [ ] **Step 6: Verify the frontend builds**

Run: `cd web && npm run build 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Dashboard.tsx \
        web/src/components/Dashboard.css
git commit -m "feat(web): integrate create/kill modals into Dashboard

Adds + Create button to sessions panel header, Kill button per
session row (disabled for active sessions with clients), and
wires up both modals with auto-refresh on success."
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run full workspace tests**

Run: `cargo test --workspace 2>&1 | tail -20`
Expected: All tests pass (existing 84+ plus new ones).

- [ ] **Step 2: Build the web frontend**

Run: `cd web && npm run build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 3: Build the full Rust project**

Run: `cargo build --release 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "chore: final fixes from integration verification"
```
