# Design: Distributed Tmux Agent System

**Date**: 2026-06-27
**Status**: Draft
**Author**: AI Assistant
**Source**: [Requirements](../requirement/2026-06-27-tmux-agent-system-requirement.md) | [Architecture](../architectures/2026-06-27-tmux-agent-system-architecture.md)

## Overview

This document specifies the implementation design for a distributed tmux agent system consisting of a central server, local agents, and unified CLI client. The system enables remote tmux session management with low-latency terminal I/O across multiple machines.

**Key Design Decisions:**
- **Unified binary**: Single `nession` binary with subcommands for server, agent, and client modes
- **Hybrid tmux integration**: Command execution for session management, pty control mode for terminal I/O
- **P2P-first connectivity**: Prefer direct client-agent connections, relay fallback via server
- **JSON protocol**: Human-readable WebSocket messages for easy debugging
- **Pure Rust TLS**: rustls for all encrypted connections (no C dependencies)

## Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| WebSocket | tokio-tungstenite | Industry standard, tokio integration |
| TLS | rustls | Pure Rust, no C deps, modern crypto |
| Serialization | serde_json | Human-readable, native browser support |
| Tmux Management | std::process::Command | Simple, debuggable, sufficient for infrequent ops |
| Tmux I/O | pty (tmux control mode) | High performance for real-time terminal I/O |
| Async Runtime | tokio | Mature, excellent WebSocket/tls support |
| Logging | tracing + tracing-subscriber | Structured async logging, tokio integration |
| Configuration | TOML | Rust ecosystem standard, supports comments |
| Database | SQLite (rusqlite) | Lightweight, embedded, no external deps |
| Web Framework | React + TypeScript | xterm.js integration, ecosystem maturity |
| Terminal Emulator | xterm.js | Industry standard, mobile-friendly |

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Server (Rust)                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ WebSocket    │  │ Agent        │  │ Session              │  │
│  │ Server       │  │ Registry     │  │ Registry             │  │
│  │ (WSS + TLS)  │  │              │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ Connection   │  │ SQLite DB    │                             │
│  │ Broker       │  │              │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
                           ▲ ▲ ▲
                           │ │ │ (WSS connections)
                           │ │ │
        ┌──────────────────┘ │ └──────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Local Agent  │   │  Local Agent  │   │  Local Agent  │
│  (Rust)       │   │  (Rust)       │   │  (Rust)       │
│  ┌─────────┐  │   │  ┌─────────┐  │   │  ┌─────────┐  │
│  │ Tmux    │  │   │  │ Tmux    │  │   │  │ Tmux    │  │
│  │ Manager │  │   │  │ Manager │  │   │  │ Manager │  │
│  │ (cmd)   │  │   │  │ (cmd)   │  │   │  │ (cmd)   │  │
│  └─────────┘  │   │  └─────────┘  │   │  └─────────┘  │
│  ┌─────────┐  │   │  ┌─────────┐  │   │  ┌─────────┐  │
│  │ Tmux    │  │   │  │ Tmux    │  │   │  │ Tmux    │  │
│  │ Control │  │   │  │ Control │  │   │  │ Control │  │
│  │ Mode    │  │   │  │ Mode    │  │   │  │ Mode    │  │
│  │ (pty)   │  │   │  │ (pty)   │  │   │  │ (pty)   │  │
│  └─────────┘  │   │  └─────────┘  │   │  └─────────┘  │
│  ┌─────────┐  │   │  ┌─────────┐  │   │  ┌─────────┐  │
│  │WebSocket│  │   │  │WebSocket│  │   │  │WebSocket│  │
│  │ Server  │  │   │  │ Server  │  │   │  │ Server  │  │
│  │ (WSS)   │  │   │  │ (WSS)   │  │   │  │ (WSS)   │  │
│  └─────────┘  │   │  └─────────┘  │   │  └─────────┘  │
└───────────────────┘   └───────────────────┘   └───────────────────┘
        ▲                       ▲                       ▲
        │                       │                       │
        │    ┌──────────────────┴──────────────────┐   │
        │    │                                     │   │
        ▼    ▼                                     ▼   ▼
┌─────────────────┐                    ┌─────────────────┐
│  nession CLI    │                    │  Web UI Client  │
│  (Rust)         │                    │  (React + TS)   │
│  ┌───────────┐  │                    │  ┌───────────┐  │
│  │ WebSocket │  │                    │  │ xterm.js  │  │
│  │ Client    │  │                    │  │ Terminal  │  │
│  │ (WSS)     │  │                    │  │           │  │
│  └───────────┘  │                    │  └───────────┘  │
│  ┌───────────┐  │                    │  ┌───────────┐  │
│  │ Terminal  │  │                    │  │ WebSocket │  │
│  │ Raw Mode  │  │                    │  │ Client    │  │
│  └───────────┘  │                    │  │ (WSS)     │  │
└─────────────────┘                    │  └───────────┘  │
                                       └─────────────────┘
```

## Component Design

### 1. Server (Control-Plane)

**Responsibilities:**
- Accept and authenticate agent/client connections (WSS)
- Maintain agent and session registries
- Broker P2P connections
- Provide relay fallback
- Persist metadata to SQLite

**Internal Architecture:**

```
Server
├── WebSocket Server (tokio-tungstenite + rustls)
│   ├── Agent Connection Handler
│   │   ├── Authenticate agent (validate token)
│   │   ├── Process registration messages
│   │   ├── Process heartbeat messages
│   │   └── Process session update messages
│   ├── Client Connection Handler
│   │   ├── Authenticate client (validate token)
│   │   ├── Handle session list requests
│   │   ├── Handle attach requests (P2P or relay)
│   │   └── Manage relay forwarding
│   └── Connection Broker
│       ├── Generate P2P connection tokens
│       ├── Exchange agent IP:port with client
│       └── Clean up stale connection requests
├── Agent Registry (Arc<RwLock<HashMap<String, AgentInfo>>>)
│   ├── Register/unregister agents
│   ├── Update heartbeats
│   ├── Mark agents offline (heartbeat timeout)
│   └── Background task: check for offline agents
├── Session Registry (Arc<RwLock<HashMap<String, SessionInfo>>>)
│   ├── Update session info (from agent updates)
│   ├── Query sessions (all, by agent)
│   └── Remove sessions (when agent goes offline)
├── SQLite Database
│   ├── agents table (agent_id, hostname, ip, port, status, token_hash, metadata)
│   ├── sessions table (session_id, agent_id, name, status, window_count, attached_clients)
│   └── connections table (connection_id, client_type, session_id, mode)
└── Configuration (TOML)
    ├── listen_address (default: 0.0.0.0:8443)
    ├── tls_cert_path, tls_key_path
    ├── auth_token (for agent/client authentication)
    ├── heartbeat_timeout_secs (default: 30)
    └── db_path (default: ./nession-server.db)
```

**CLI Commands:**

```bash
nession server start              # Start server
nession server stop               # Stop server (graceful shutdown)
nession server status             # Show server status
```

### 2. Local Agent

**Responsibilities:**
- Manage tmux sessions (create, list, kill, rename)
- Attach to tmux sessions for I/O forwarding
- Accept connections from server (heartbeat, session updates)
- Accept P2P connections from clients (direct terminal I/O)
- Report status and metrics to server

**Internal Architecture:**

```
Local Agent
├── Tmux Manager (dual-mode)
│   ├── Command Mode (std::process::Command)
│   │   ├── list_sessions() → tmux list-sessions
│   │   ├── create_session() → tmux new-session
│   │   ├── kill_session() → tmux kill-session
│   │   └── send_keys() → tmux send-keys
│   └── Control Mode (pty)
│       ├── attach_session() → spawn tmux -C attach
│       ├── read_output() → read from pty stdout
│       ├── write_input() → write to pty stdin
│       └── resize() → tmux refresh-client -x W -y H
├── WebSocket Server (tokio-tungstenite + rustls)
│   ├── Server Connection (outbound)
│   │   ├── Connect to server on startup
│   │   ├── Send registration message
│   │   ├── Send heartbeats every 10s
│   │   └── Send session updates when sessions change
│   └── Client Connections (inbound, P2P)
│       ├── Accept P2P connections from clients
│       ├── Validate connection token
│       ├── Attach to requested tmux session (pty mode)
│       └── Forward I/O between client and tmux
├── Session Registry (local cache)
│   ├── Track active sessions
│   ├── Track attached clients per session
│   └── Notify server of changes
└── Configuration (TOML)
    ├── agent_id (unique identifier)
    ├── server_url (wss://server:8443)
    ├── auth_token (for server authentication)
    ├── listen_address (default: 0.0.0.0:8080, for P2P)
    ├── tls_cert_path, tls_key_path
    ├── heartbeat_interval_secs (default: 10)
    └── tmux_socket_path (optional, default: /tmp/tmux-{uid}/default)
```

**CLI Commands:**

```bash
nession agent start               # Start agent
nession agent stop                # Stop agent (graceful shutdown)
nession agent status              # Show agent status
```

### 3. CLI Client

**Responsibilities:**
- Connect to server (WSS)
- Authenticate with token
- List agents and sessions
- Attach to sessions (P2P or relay)
- Forward terminal I/O in raw mode
- Handle reconnection on network failure

**Internal Architecture:**

```
CLI Client
├── WebSocket Client (tokio-tungstenite + rustls)
│   ├── Connect to server
│   ├── Authenticate (send token)
│   ├── Send requests (list agents, list sessions, attach)
│   └── Receive responses and I/O stream
├── Terminal Handler (crossterm)
│   ├── Enter raw mode (disable line buffering, echo)
│   ├── Capture keyboard input → send to agent
│   ├── Receive terminal output → write to stdout
│   ├── Handle terminal resize → send resize to agent
│   └── Exit raw mode on disconnect
├── Connection Manager
│   ├── Try P2P connection first
│   ├── Fall back to relay if P2P fails
│   ├── Detect disconnection
│   └── Automatic reconnection with exponential backoff
└── Configuration (TOML)
    ├── server_url (wss://server:8443)
    ├── auth_token (for authentication)
    └── preferred_mode (p2p or relay, default: p2p)
```

**CLI Commands:**

```bash
nession agents list                                          # List all agents
nession sessions list [--agent-id AGENT_ID]                  # List sessions
nession session create --agent-id AGENT_ID --name NAME       # Create session
nession session attach --session-id AGENT_ID:NAME            # Attach to session
nession session kill --session-id AGENT_ID:NAME              # Kill session
```

### 4. Web UI Client

**Responsibilities:**
- Display session dashboard (list of agents and sessions)
- Provide terminal emulator for attached sessions
- Handle authentication (token input)
- Mobile-responsive layout

**Internal Architecture:**

```
Web UI (React + TypeScript)
├── Components
│   ├── LoginForm
│   │   ├── Token input field
│   │   └── Connect button
│   ├── Dashboard
│   │   ├── Agent list (status, hostname, session count)
│   │   ├── Session list (name, agent, status, attached clients)
│   │   └── Action buttons (create, attach, kill)
│   └── Terminal
│       ├── xterm.js terminal emulator
│       ├── WebSocket client (connects to server or agent)
│       ├── Input handler (keyboard → WebSocket)
│       ├── Output handler (WebSocket → xterm.js)
│       └── Resize handler (viewport change → resize message)
├── Services
│   ├── WebSocketService
│   │   ├── Manage connection to server
│   │   ├── Handle authentication
│   │   ├── Send requests and receive responses
│   │   └── Manage P2P/relay connection switching
│   └── ApiService
│       ├── listAgents()
│       ├── listSessions()
│       ├── createSession()
│       ├── attachSession()
│       └── killSession()
└── State Management (React Context or Redux)
    ├── Auth state (token, connection status)
    ├── Agent list state
    ├── Session list state
    └── Active terminal state
```

## Data Flow and Protocols

### WebSocket Message Protocol

All messages use JSON format with a common envelope:

```json
{
  "type": "message_type",
  "id": "unique_message_id",
  "timestamp": 1234567890,
  "payload": { ... }
}
```

### Message Types

#### Server ↔ Agent Messages

**Agent Registration** (agent → server)
```json
{
  "type": "agent.register",
  "id": "msg_001",
  "timestamp": 1234567890,
  "payload": {
    "agent_id": "agent_abc123",
    "hostname": "dev-server-01",
    "ip_address": "192.168.1.10",
    "port": 8080,
    "auth_token": "token_xyz",
    "metadata": {
      "tmux_version": "3.3a",
      "os_version": "Ubuntu 22.04",
      "nession_version": "0.1.0"
    },
    "protocol_version": "1.0"
  }
}
```

**Registration Response** (server → agent)
```json
{
  "type": "agent.register.response",
  "id": "msg_002",
  "timestamp": 1234567890,
  "payload": {
    "status": "accepted",
    "message": "Registration successful"
  }
}
```

**Agent Heartbeat** (agent → server)
```json
{
  "type": "agent.heartbeat",
  "id": "msg_003",
  "timestamp": 1234567890,
  "payload": {
    "agent_id": "agent_abc123",
    "status": "online",
    "session_count": 5,
    "active_sessions": 3,
    "metadata": {
      "uptime_seconds": 86400,
      "load_average": [0.5, 0.7, 0.6]
    }
  }
}
```

**Session Update** (agent → server)
```json
{
  "type": "agent.session.update",
  "id": "msg_004",
  "timestamp": 1234567890,
  "payload": {
    "agent_id": "agent_abc123",
    "session_name": "dev-work",
    "status": "active",
    "window_count": 3,
    "attached_clients": 1
  }
}
```

#### Client ↔ Server Messages

**Client Authentication** (client → server)
```json
{
  "type": "client.auth",
  "id": "msg_010",
  "timestamp": 1234567890,
  "payload": {
    "auth_token": "client_token_xyz"
  }
}
```

**Auth Response** (server → client)
```json
{
  "type": "client.auth.response",
  "id": "msg_011",
  "timestamp": 1234567890,
  "payload": {
    "status": "accepted",
    "message": "Authentication successful"
  }
}
```

**List Agents Request** (client → server)
```json
{
  "type": "client.agents.list",
  "id": "msg_012",
  "timestamp": 1234567890,
  "payload": {}
}
```

**List Agents Response** (server → client)
```json
{
  "type": "client.agents.list.response",
  "id": "msg_013",
  "timestamp": 1234567890,
  "payload": {
    "agents": [
      {
        "agent_id": "agent_abc123",
        "hostname": "dev-server-01",
        "status": "online",
        "session_count": 5,
        "active_sessions": 3,
        "registered_at": 1234567890,
        "last_heartbeat": 1234567900
      }
    ]
  }
}
```

**List Sessions Request** (client → server)
```json
{
  "type": "client.sessions.list",
  "id": "msg_014",
  "timestamp": 1234567890,
  "payload": {
    "agent_id": "agent_abc123"
  }
}
```

**List Sessions Response** (server → client)
```json
{
  "type": "client.sessions.list.response",
  "id": "msg_015",
  "timestamp": 1234567890,
  "payload": {
    "sessions": [
      {
        "session_id": "agent_abc123:dev-work",
        "agent_id": "agent_abc123",
        "session_name": "dev-work",
        "status": "active",
        "window_count": 3,
        "attached_clients": 1
      }
    ]
  }
}
```

**Attach Session Request** (client → server)
```json
{
  "type": "client.session.attach",
  "id": "msg_016",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "preferred_mode": "p2p"
  }
}
```

**P2P Connection Info** (server → client, for P2P mode)
```json
{
  "type": "client.session.attach.p2p_info",
  "id": "msg_017",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "agent_ip": "192.168.1.10",
    "agent_port": 8080,
    "connection_token": "temp_token_for_p2p_auth"
  }
}
```

**Relay Ready** (server → client, for relay mode)
```json
{
  "type": "client.session.attach.relay_ready",
  "id": "msg_018",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "message": "Relay established, start streaming I/O"
  }
}
```

#### Client ↔ Agent Messages (P2P or via Relay)

**Terminal Input** (client → agent)
```json
{
  "type": "terminal.input",
  "id": "msg_100",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "data": "ls -la\n"
  }
}
```

**Terminal Output** (agent → client)
```json
{
  "type": "terminal.output",
  "id": "msg_101",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "data": "total 42\n-rw-r--r-- 1 user group 1234 Jan 1 00:00 file.txt\n"
  }
}
```

**Terminal Resize** (client → agent)
```json
{
  "type": "terminal.resize",
  "id": "msg_102",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "width": 120,
    "height": 40
  }
}
```

**Session Control** (client → agent)
```json
{
  "type": "session.control",
  "id": "msg_103",
  "timestamp": 1234567890,
  "payload": {
    "action": "create",
    "agent_id": "agent_abc123",
    "session_name": "new-session",
    "width": 120,
    "height": 40
  }
}
```

**Session Control Response** (agent → client)
```json
{
  "type": "session.control.response",
  "id": "msg_104",
  "timestamp": 1234567890,
  "payload": {
    "action": "create",
    "status": "success",
    "session_id": "agent_abc123:new-session",
    "message": "Session created successfully"
  }
}
```

### Data Flow Diagrams

#### Flow 1: Agent Registration and Heartbeat

```
┌─────────┐                         ┌─────────┐
│  Agent  │                         │  Server │
└────┬────┘                         └────┬────┘
     │                                   │
     │  1. Connect WSS                   │
     ├──────────────────────────────────►│
     │                                   │
     │  2. agent.register                │
     │     {agent_id, hostname,          │
     │      ip:port, token, metadata}    │
     ├──────────────────────────────────►│
     │                                   │
     │                        3. Validate token
     │                           Store in DB
     │                           Add to registry
     │
     │  4. agent.register.response       │
     │     {status: accepted}            │
     │◄──────────────────────────────────┤
     │                                   │
     │  5. Start heartbeat loop          │
     │     (every 10 seconds)            │
     │                                   │
     │  6. agent.heartbeat               │
     │     {status, session_count,       │
     │      active_sessions, metadata}   │
     ├──────────────────────────────────►│
     │                                   │
     │                        7. Update heartbeat
     │                           Update sessions
     │
     │  8. (ack implicit in next heartbeat cycle)
     │                                   │
     │  9. agent.session.update          │
     │     (when sessions change)        │
     ├──────────────────────────────────►│
     │                                   │
     │                        10. Update session registry
     │
```

#### Flow 2: Client Attaches via P2P Mode

```
┌─────────┐                ┌─────────┐                ┌─────────┐
│  Client │                │  Server │                │  Agent  │
└────┬────┘                └────┬────┘                └────┬────┘
     │                          │                          │
     │ 1. Connect WSS           │                          │
     ├─────────────────────────►│                          │
     │                          │                          │
     │ 2. client.auth           │                          │
     │    {auth_token}          │                          │
     ├─────────────────────────►│                          │
     │                          │                          │
     │ 3. auth.response         │                          │
     │◄─────────────────────────┤                          │
     │                          │                          │
     │ 4. client.session.attach │                          │
     │    {session_id,          │                          │
     │     mode: p2p}           │                          │
     ├─────────────────────────►│                          │
     │                          │                          │
     │                          │ 5. Query agent info      │
     │                          │    for session           │
     │                          ├─────────────────────────►│
     │                          │                          │
     │                          │ 6. Agent info            │
     │                          │    {ip:port}             │
     │                          │◄─────────────────────────┤
     │                          │                          │
     │ 7. p2p_info              │                          │
     │    {agent_ip:port,       │                          │
     │     connection_token}    │                          │
     │◄─────────────────────────┤                          │
     │                          │                          │
     │ 8. Direct WSS to agent   │                          │
     │    with connection_token │                          │
     ├────────────────────────────────────────────────────►│
     │                          │                          │
     │                          │                9. Validate token
     │                          │                   Attach to tmux (pty)
     │                          │
     │ 10. terminal.input       │                          │
     ├────────────────────────────────────────────────────►│
     │                          │                          │
     │                          │                11. Write to pty stdin
     │                          │                   Read from pty stdout
     │                          │
     │ 12. terminal.output      │                          │
     │◄────────────────────────────────────────────────────┤
     │                          │                          │
     │ 13. Bidirectional I/O    │                          │
     │◄───────────────────────────────────────────────────►│
     │                          │                          │
```

#### Flow 3: Client Attaches via Relay Mode

```
┌─────────┐                ┌─────────┐                ┌─────────┐
│  Client │                │  Server │                │  Agent  │
└────┬────┘                └────┬────┘                └────┬────┘
     │                          │                          │
     │ 1. Connect WSS           │                          │
     ├─────────────────────────►│                          │
     │                          │                          │
     │ 2. client.auth           │                          │
     ├─────────────────────────►│                          │
     │                          │                          │
     │ 3. auth.response         │                          │
     │◄─────────────────────────┤                          │
     │                          │                          │
     │ 4. client.session.attach │                          │
     │    {session_id,          │                          │
     │     mode: relay}         │                          │
     ├─────────────────────────►│                          │
     │                          │                          │
     │                          │ 5. Notify agent:         │
     │                          │    client attaching      │
     │                          │    (via existing WSS)    │
     │                          ├─────────────────────────►│
     │                          │                          │
     │                          │                6. Attach to tmux (pty)
     │                          │
     │ 7. relay_ready           │                          │
     │◄─────────────────────────┤                          │
     │                          │                          │
     │ 8. terminal.input        │                          │
     ├─────────────────────────►│ 9. Forward to agent      │
     │                          ├─────────────────────────►│
     │                          │                          │
     │                          │                10. Write to pty
     │                          │
     │                          │ 11. terminal.output      │
     │                          │◄─────────────────────────┤
     │ 12. terminal.output      │                          │
     │◄─────────────────────────┤                          │
     │                          │                          │
     │ 13. Bidirectional I/O    │                          │
     │    (all via server relay)│                          │
     │◄────────────────────────►├─────────────────────────►│
     │                          │                          │
```

## Error Handling

### Connection Errors

| Scenario | Detection | Handling |
|----------|-----------|----------|
| **WebSocket connection fails** | TCP timeout, connection refused | Retry with exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max). After 5 failures, log error and stop retrying. |
| **TLS handshake fails** | Certificate error, protocol mismatch | Log detailed error. For self-signed certs, provide instructions to add cert to trust store. No automatic retry. |
| **Network interruption during session** | WebSocket close event, read timeout | Client: attempt reconnection (exponential backoff). On reconnect, re-attach to session. Server: detect missing heartbeat, mark agent offline after 30s. |
| **Server restart** | All agent/client connections close | Agents: detect disconnect, reconnect with backoff, re-register. Clients: detect disconnect, reconnect, re-authenticate, re-attach. |
| **Agent restart** | Server detects missing heartbeat (30s timeout) | Server: mark agent offline, notify connected clients. Agent: on restart, reconnect to server, re-register. |

### Authentication Errors

| Scenario | Detection | Handling |
|----------|-----------|----------|
| **Invalid agent token** | Token hash mismatch on registration | Server: reject registration, return error "Invalid authentication token". Agent: log error, exit. |
| **Invalid client token** | Token mismatch on client.auth | Server: reject connection, return error "Invalid authentication token". Client: display error, prompt for correct token. |
| **Missing token** | Empty or null token field | Server: reject connection, return error "Authentication token required". |

### Protocol Errors

| Scenario | Detection | Handling |
|----------|-----------|----------|
| **Invalid JSON** | serde_json parse error | Log error with message preview. Close connection with "Invalid message format" error. |
| **Unknown message type** | type field doesn't match known types | Log warning. Ignore message (don't close connection). |
| **Missing required fields** | Payload missing required keys | Return error response with list of missing fields. |
| **Message too large** | Message size > 1MB | Close connection with "Message too large (max 1MB)" error. |
| **Invalid UTF-8** | String not valid UTF-8 | Return error "Invalid UTF-8 in message". Don't forward to tmux. |

### Application Errors

| Scenario | Detection | Handling |
|----------|-----------|----------|
| **Session not found** | session_id not in registry | Return error "Session '{session_id}' does not exist". |
| **Agent offline** | agent_id status = offline | Return error "Agent '{agent_id}' is offline". |
| **Session name conflict** | tmux new-session fails (name exists) | Return error "Session '{name}' already exists on agent '{agent_id}'". |
| **Tmux not installed** | `which tmux` fails at agent startup | Agent: log error "tmux not found. Please install tmux 2.6 or later", exit. |
| **Tmux server crash** | tmux commands fail unexpectedly | Agent: attempt to restart tmux server. If fails, log error, notify server of degraded status. |
| **P2P connection refused** | Client can't connect to agent IP:port | Client: log warning, fall back to relay mode automatically. |
| **P2P and relay both fail** | Neither connection mode works | Client: return error with troubleshooting steps. |
| **Multiple clients attach to same session** | tmux supports this natively | No error. Agent spawns separate pty per client. All clients receive I/O stream. |

## Edge Cases

### Agent-Side Edge Cases

1. **Tmux version too old**: Agent checks `tmux -V` at startup. If version < 2.6, exit with error.
2. **Agent process crash**: Agent attempts graceful shutdown. If unclean crash, server detects missing heartbeat after 30s.
3. **Disk space exhaustion**: Tmux commands fail. Agent returns error but continues running.
4. **Concurrent session creation with same name**: tmux rejects duplicate names. Agent returns error immediately.
5. **Large terminal output (>1MB)**: Agent splits output into multiple terminal.output messages.

### Server-Side Edge Cases

1. **Database corruption**: Server validates SQLite on startup. If corrupted, attempt recovery or delete and start fresh.
2. **Metadata corruption**: Server validates JSON metadata on load. If invalid, log warning, set to empty object.
3. **Relay overload**: Server monitors relay connection count. If >80%, log warning.
4. **Duplicate agent ID registration**: Server checks if agent_id exists. If yes, reject.
5. **Concurrent session updates**: Server uses RwLock for session registry. Updates are atomic.

### Client-Side Edge Cases

1. **Browser tab close during session**: Session on agent unaffected. Reopening Web UI allows reattach.
2. **Mobile device rotation**: Web UI detects viewport resize, sends terminal.resize message.
3. **CLI Ctrl+C during attach**: CLI catches SIGINT, exits raw mode, returns to normal terminal.
4. **Slow network**: Client requests agent to throttle if output queue >100 messages.
5. **Firewall blocking WebSocket**: Connection fails with timeout. Client displays error with troubleshooting steps.

## Logging Strategy

**Log Levels:**
- **ERROR**: Connection failures, authentication failures, tmux command failures, database errors
- **WARN**: P2P fallback to relay, high relay usage, slow network, deprecated message types
- **INFO**: Agent registration, client authentication, session create/kill, heartbeat received
- **DEBUG**: Message sent/received (full payload), tmux command execution, connection state changes
- **TRACE**: Internal state transitions, lock acquisitions, timer events

**Log Format (Production):**
```json
{
  "timestamp": "2026-06-27T10:00:00.123Z",
  "level": "INFO",
  "target": "nession::server::agent_registry",
  "message": "Agent registered successfully",
  "fields": {
    "agent_id": "agent_abc123",
    "hostname": "dev-server-01",
    "ip_address": "192.168.1.10"
  }
}
```

**Log Output:**
- Development: Human-readable format to stdout
- Production: JSON format to stdout (for log aggregation)
- Configurable via `RUST_LOG` environment variable or config file

## Health Checks

**Server Health Endpoint:**
```
GET /health
Response: 200 OK
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": 86400,
  "agents_online": 5,
  "agents_total": 7,
  "sessions_active": 23,
  "connections_relay": 10,
  "connections_p2p": 15
}
```

**Agent Health:**
- Agent reports status in heartbeat (online, offline, degraded)
- Degraded status: tmux commands failing but agent running
- Offline status: no heartbeat for 30s

## Testing Strategy

### Unit Tests

- **nession-common**: Protocol message serialization, configuration parsing, token validation
- **nession-server**: Agent registry, session registry, connection broker
- **nession-agent**: Tmux manager (mock command execution), local session registry
- **nession-cli**: Terminal raw mode, WebSocket client message handling

### Integration Tests

- **Server ↔ Agent**: Registration flow, heartbeat timeout detection, session update propagation
- **Client ↔ Server**: Authentication, session listing, attach requests
- **End-to-End**: P2P attach, relay attach, multiple clients on same session, reconnection

### Performance Tests

- 100 agents concurrent registration
- 1000 sessions concurrent creation
- Latency measurement: P95 < 100ms (relay), P99 < 200ms
- Agent resource usage: < 50MB RAM, < 5% CPU (10 idle sessions)

### Test Coverage Goals

- **Unit tests**: 80%+ code coverage for core logic
- **Integration tests**: Cover all major workflows
- **Performance tests**: Validate latency and throughput targets
- **Edge case tests**: Cover all edge cases from requirements

## Out of Scope

This design deliberately does NOT cover:

- **Server clustering**: v1 is single-instance. Stateless design allows future clustering.
- **NAT traversal**: P2P assumes direct IP:port reachability (intranet deployment).
- **Multi-tenant isolation**: Single trusted operator model.
- **Session recording/playback**: Terminal I/O forwarded in real-time but not recorded.
- **AI framework integrations**: System provides primitives but no direct integrations.
- **Desktop native apps**: Web UI covers desktop use cases.
- **File transfer**: No file upload/download between client and agent hosts.
- **Public internet deployment**: No DDoS protection, WAF, or public-facing security hardening.
- **OAuth/OIDC authentication**: Token-based auth only.
- **Database replication**: SQLite is single-file, no replication.

## Implementation Order

1. **Phase 1: Server** (~1 week)
   - WebSocket server with TLS
   - Agent registry and session registry
   - SQLite database
   - Authentication
   - Health endpoint

2. **Phase 2: Agent** (~1 week)
   - Tmux manager (command mode)
   - Tmux control mode (pty) for I/O
   - WebSocket server for P2P connections
   - Server connection and heartbeat
   - Session management

3. **Phase 3: CLI Client** (~1 week)
   - WebSocket client
   - Terminal raw mode
   - Session listing and attachment
   - P2P and relay connection modes
   - Reconnection logic

4. **Phase 4: Web UI** (~1 week)
   - React + TypeScript setup
   - xterm.js terminal emulator
   - Dashboard (agents, sessions)
   - WebSocket client
   - Mobile-responsive layout

**Total estimated timeline**: ~4 weeks
