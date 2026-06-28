# WebUI Session Create & Kill — Design Spec

**Date:** 2026-06-28
**Status:** Approved

## Overview

Add the ability to create and destroy tmux sessions directly from the WebUI Dashboard. Currently the CLI supports these operations, but the WebUI only allows viewing and attaching. This feature closes that gap.

## Architecture Decision

**Approach B: Bidirectional Control Connection**

The Server sends commands to Agents through the existing control connection (Agent → Server), rather than opening a temporary WebSocket to the Agent's AgentServer. This keeps the architecture clean: the control connection becomes the command channel, while AgentServer remains dedicated to real-time P2P terminal I/O (attach).

## Protocol Extensions

### New Message Types

**Server → Agent (via control connection):**

| msg_type | Payload | Description |
|---|---|---|
| `server.session.create` | `{ request_id, name, width?, height? }` | Create a tmux session |
| `server.session.kill` | `{ request_id, name }` | Kill a tmux session |

**Agent → Server (command response):**

| msg_type | Payload | Description |
|---|---|---|
| `agent.session.command.response` | `{ request_id, command, success, error?, session_name? }` | Generic command response |

**Client → Server (existing request/response pattern):**

| Direction | msg_type | Payload |
|---|---|---|
| Client → Server | `client.session.create` | `{ agent_id, name }` |
| Server → Client | `client.session.create.response` | `{ success, session_id?, error? }` |
| Client → Server | `client.session.kill` | `{ session_id }` |
| Server → Client | `client.session.kill.response` | `{ success, error? }` |

Request/response correlation uses `request_id`. The Agent's response includes a `command` field (`"session.create"` or `"session.kill"`) to distinguish which command it is responding to.

## Server-Side Changes

### New Component: CommandBroker

The current `ConnectionHandler` is per-connection and cannot send messages across connections. A new `CommandBroker` bridges client requests to agent control connections.

```
AgentRegistry (existing)        CommandBroker (new)
  ┌─────────────────┐          ┌─────────────────────────┐
  │ agent_id → info  │          │ agent_id → AgentControl  │
  │ (metadata/status)│          │  - sink (write half)     │
  └─────────────────┘          │  - pending_commands       │
                               │    (request_id → oneshot)│
                               └─────────────────────────┘
```

**`AgentControl`** — created when each Agent registers:
- `sink`: `Arc<Mutex<WsSink>>` — the write half of the Agent's control WebSocket
- `pending_commands`: `HashMap<String, oneshot::Sender<Value>>` — awaiting Agent responses, keyed by `request_id`

The `CommandBroker` itself holds:
```rust
struct CommandBroker {
    // Nested map: agent_id → (request_id → oneshot::Sender)
    // When an agent disconnects, the entire inner map is dropped,
    // resolving all pending oneshots with RecvError automatically.
    agents: RwLock<HashMap<String, AgentControl>>,
}
```

### Request Flow

```
Client ──client.session.create──► Server Handler
                                     │
                                     │ 1. Generate request_id
                                     │ 2. Create oneshot channel
                                     │ 3. Store in CommandBroker.pending_commands
                                     │ 4. Send server.session.create to Agent via sink
                                     │ 5. await oneshot receiver (with timeout)
                                     ▼
Agent ◄──server.session.create──── Server
  │
  │ Execute tmux new-session
  │
  └──agent.session.command.response──► Server
                                        │
                                        │ handle_agent_command_response()
                                        │ Lookup request_id → send result via oneshot
                                        ▼
                                   Handler receives result
                                        │
                                        └──client.session.create.response──► Client
```

### Handler Changes

New handlers in `ConnectionHandler`:
- `handle_client_session_create` — validates auth, checks agent exists and is online, delegates to CommandBroker
- `handle_client_session_kill` — validates auth, checks session exists, delegates to CommandBroker
- `handle_agent_command_response` — receives Agent's response, resolves the pending oneshot

### Agent Connection Lifecycle

On `agent.register`:
- Register the connection's `sink` into `CommandBroker`

On agent disconnect:
- Remove entry from `CommandBroker`
- Resolve all pending oneshots for that agent with an error

`ConnectionHandler` holds an `Arc<CommandBroker>` reference.

## Agent-Side Changes

### `handle_server_message` Extension

Currently only handles `agent.register.response`. Extended to handle server commands:

```rust
match msg.msg_type.as_str() {
    "agent.register.response" => { /* existing logic */ }
    "server.session.create" => {
        // 1. Parse request_id, name, width, height
        // 2. Call TmuxManager::create_session(name, width, height)
        // 3. Build agent.session.command.response
        // 4. Send back to Server via sink
    }
    "server.session.kill" => {
        // 1. Parse request_id, name
        // 2. Call TmuxManager::kill_session(name)
        // 3. Build agent.session.command.response
        // 4. Send back to Server via sink
    }
    _ => { /* existing logic: debug log */ }
}
```

### TmuxManager Access

`handle_server_message` is currently a static method and cannot access `TmuxManager`. Changes:
- Pass `Arc<TmuxManager>` into `run_message_loop`
- `handle_server_message` receives `TmuxManager` reference as parameter

```rust
async fn run_message_loop(
    mut ws_stream: WsStreamHalf,
    sink: Arc<Mutex<WsSink>>,
    mut shutdown_rx: mpsc::Receiver<()>,
    agent_id: String,
    tmux: Arc<TmuxManager>,  // new parameter
) { ... }
```

### Command Response Format

Success:
```json
{
  "msg_type": "agent.session.command.response",
  "id": "<uuid>",
  "timestamp": 1234567890,
  "payload": {
    "request_id": "<from server message>",
    "command": "session.create",
    "success": true,
    "session_name": "my-session"
  }
}
```

Failure:
```json
{
  "payload": {
    "request_id": "<from server message>",
    "command": "session.kill",
    "success": false,
    "error": "session 'foo' not found"
  }
}
```

## WebUI Changes

### New Components

**`CreateSessionModal.tsx`** — Create Session dialog:
- Target Agent dropdown (populated from connected agents list, only online agents)
- Session name input (required, validated: non-empty, no special characters)
- Confirm/Cancel buttons
- Loading state while waiting for response
- Success: close modal, Dashboard refreshes via `sessions.changed` event
- Failure: display error message inline

**`ConfirmKillModal.tsx`** — Kill confirmation dialog:
- Display session info (session_id, owning agent)
- Confirm/Cancel buttons
- Loading state while waiting for response
- Success: close modal, list refreshes
- Failure: display error message inline
- Both modals support ESC to close

### Dashboard Layout Changes

```
┌─────────────────────────────────────────────────────┐
│  Agents          │  Sessions                        │
│  ┌────────────┐  │  [+ Create Session]  ← new       │
│  │ agent-1 ●  │  │  ┌──────────────────────────┐   │
│  │ agent-2 ○  │  │  │ session-1  active  [Kill]│   │
│  └────────────┘  │  │ session-2  detached[Kill]│   │
│                  │  └──────────────────────────┘   │
│  [Attach]        │                                  │
└─────────────────────────────────────────────────────┘
```

- **+ Create Session** button at the top of the Sessions panel
- **Kill** button at the end of each session row (disabled for active sessions with attached clients, or hidden)
- When an Agent is selected, the Create modal auto-fills that agent

### WebSocket Service Extensions

New methods on the WebSocket service class:
```typescript
createSession(agentId: string, name: string): Promise<CreateSessionResponse>
killSession(sessionId: string): Promise<KillSessionResponse>
```

Same pattern as existing `requestAttach` — send message, register pendingRequest, await response or timeout.

### Interaction Details

- Kill button is immediately disabled after click to prevent double-clicks
- Error messages display inline in the modal, no global toast
- Create button auto-fills target Agent when an agent is selected in the left panel

## Error Handling

### Timeouts

| Stage | Timeout | Behavior |
|---|---|---|
| Server waiting for Agent response | 10s | Return `timeout` error to Client |
| WebUI waiting for Server response | 15s | Display timeout error in modal |
| Agent executing tmux command | 5s | Return `error`, do not block control connection |

### Agent Offline / Not Found

- `client.session.create` with target agent_id not in registry or offline → Server returns error immediately, no command sent
- `client.session.kill` with target session's agent offline → Server removes session from registry, returns success (session no longer exists)

### Concurrency

- `CommandBroker.agents` uses `RwLock<HashMap<String, AgentControl>>`, with `AgentControl.pending_commands` as `Mutex<HashMap<request_id, oneshot::Sender>>`. When an agent disconnects, the outer `remove()` drops the inner map, resolving all pending oneshots with `RecvError`.
- Agent control connection sink writes protected by `Mutex` (shared with existing heartbeat/session update)
- Multiple concurrent commands to the same Agent are valid (e.g., creating two sessions simultaneously), distinguished by `request_id`

### Duplicate Create / Kill

- `tmux new-session -d -s name` fails if session exists → Agent returns `success: false, error: "session already exists"`
- `tmux kill-session -t name` fails if session doesn't exist → Agent returns error
- Server transparently passes Agent errors to Client

### Session Auto-Discovery

- After successful create, Agent's `SessionWatcher` (polls every 5s) detects the new session and sends `agent.session.update`
- Server updates `SessionRegistry` and broadcasts `sessions.changed` event
- WebUI automatically shows the new session (no strict sync required between create response and session event)

### Network Disconnect

- Agent disconnects while Server is waiting for response → `oneshot::Receiver` gets `RecvError` → Server returns `agent disconnected` error to Client
- Client disconnects while waiting for Server response → reconnect and retry (stateless, no recovery needed)

## Files to Modify

### Server (`crates/nession-server/`)
- `src/server/handler.rs` — new handlers, CommandBroker reference
- `src/server/mod.rs` — CommandBroker struct definition
- `src/server/websocket.rs` — pass CommandBroker to handler

### Agent (`crates/nession-agent/`)
- `src/connection/server_client.rs` — command handling in message loop, TmuxManager parameter

### Common (`crates/nession-common/`)
- `src/protocol.rs` — new payload types and message type constants

### WebUI (`web/src/`)
- `components/CreateSessionModal.tsx` — new component
- `components/ConfirmKillModal.tsx` — new component
- `components/Dashboard.tsx` — add buttons, integrate modals
- `services/websocket.ts` — new API methods
- `types.ts` — new TypeScript interfaces
