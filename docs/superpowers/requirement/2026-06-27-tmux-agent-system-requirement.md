# Requirements: Distributed Tmux Agent System

## Background

Developers and AI agents increasingly work across multiple machines simultaneously, each running tmux sessions for persistent terminal environments. Current pain points:

1. **Distributed development environments**: Developers manage multiple dev servers/VMs, each with independent tmux sessions. No unified view or control.
2. **AI Agent orchestration**: Multiple AI agents run in tmux sessions across machines. Need centralized monitoring and control.
3. **Remote terminal persistence**: Long-running tasks need persistent sessions that survive network disconnections and can be reattached from any device (phone, laptop, desktop).

Existing solutions (tmux + SSH, tmate, etc.) either lack centralized coordination, require complex setup, or don't scale beyond 2-3 machines. This project builds a purpose-built system with a control-plane architecture for unlimited scalability.

## Goals

1. **Unified tmux management**: Single control-plane to manage all tmux sessions across all registered agents (machines).
2. **Low-latency remote attach**: End-to-end keyboard-to-screen latency < 100ms in relay mode, < 50ms in P2P mode.
3. **Multi-client support**: CLI, Web UI, and mobile-friendly interfaces for accessing tmux sessions from any device.
4. **Hybrid connectivity**: Support both control-plane relay and P2P direct connection modes, with automatic fallback.
5. **Unlimited scalability**: Architecture supports hundreds of agents and thousands of concurrent sessions without degradation.
6. **Operational independence**: System can be deployed, monitored, and maintained by a single operator without specialized knowledge.

## Non-Goals

1. **Production-grade high availability**: Control-plane failure tolerance (clustering, failover) is out of scope for v1.
2. **Public internet deployment**: NAT traversal, tunneling, and public-facing security hardening are deferred.
3. **Multi-tenant isolation**: User isolation and multi-tenancy are not required; assume single trusted operator.
4. **Session recording/playback**: While we capture session state, full terminal session recording and replay is out of scope.
5. **AI agent framework integration**: Direct integration with AI frameworks (LangChain, AutoGPT, etc.) is deferred; the system provides primitives (session control, output capture) that agents can use.

## Scope

### In Scope

**Local Tmux Agent**
- Tmux session lifecycle management: create, list, kill, rename sessions
- Session attachment with full I/O forwarding (stdin/stdout/stderr)
- Advanced session control: send-keys, capture-pane (current screen content)
- Window and pane management: list windows, select window, split/kill panes
- Periodic heartbeat and status reporting to control-plane (session count, active/inactive status, resource usage)
- Token-based authentication for control-plane registration

**Control-Plane**
- Agent registration and discovery: agents report availability and session metadata
- Session registry: global view of all sessions across all agents
- Connection brokering: facilitate P2P direct connections between clients and agents
- Relay mode: forward traffic between client and agent when P2P is unavailable
- Lightweight metadata storage: agent registry, session metadata, connection state
- Token-based authentication for client and agent connections

**Clients**
- CLI client: command-line interface for listing agents/sessions, attaching to sessions, sending commands
- Web UI: browser-based terminal interface with session management dashboard
- Mobile-responsive design: Web UI usable on phones/tablets for quick operations

**Connectivity**
- WebSocket-based communication for all real-time I/O
- Hybrid connection modes: relay through control-plane OR direct P2P connection
- P2P connection establishment: control-plane acts as signaling server to exchange connection metadata (IP:port), then client and agent establish direct WebSocket connection
- Automatic connection mode negotiation (prefer P2P, fall back to relay)
- Reconnection handling: automatic retry with exponential backoff on connection loss

### Out of Scope

- Control-plane clustering and high availability
- NAT traversal and public internet deployment
- Multi-user authentication and authorization (RBAC)
- Session recording, playback, or audit logging
- Direct AI framework integrations
- Desktop native applications (Electron, Tauri, etc.) — Web UI covers this
- File transfer between client and agent hosts

## Security Requirements

### Transport Security

1. **TLS/WSS Encryption**: All WebSocket connections must use TLS encryption (wss:// protocol). Self-signed certificates acceptable for v1 intranet deployment, but TLS is mandatory.
2. **Certificate Management**: Agents and control-plane generate self-signed certificates on first run. Certificate pinning not required for v1 (intranet trust model).
3. **Token Transmission**: Authentication tokens transmitted only over encrypted channels (TLS/WSS). Never send tokens in plain text.

### Authentication

1. **Agent Authentication**: Agents authenticate to control-plane using pre-shared token (configured in agent config file). Token validated on registration and each heartbeat.
2. **Client Authentication**: Clients authenticate to control-plane using pre-shared token (configured in client config or entered interactively). Token validated on connection.
3. **Token Storage**: Tokens stored in configuration files (TOML/YAML) with file permissions 600 (owner read/write only). Clients store tokens in memory only (not persisted to disk).
4. **Token Rotation**: Not required for v1. Manual token update and restart required for rotation.

### Rate Limiting

1. **Connection Rate Limit**: Control-plane limits new connections to 10 per second per IP address to prevent connection floods.
2. **Message Rate Limit**: Control-plane limits WebSocket messages to 100 per second per connection to prevent message floods.
3. **Failed Authentication**: After 5 failed authentication attempts from same IP within 60 seconds, block that IP for 5 minutes.

### Input Validation

1. **UTF-8 Validation**: All text input from clients must be valid UTF-8. Reject invalid UTF-8 with error message.
2. **Message Size Limit**: Maximum WebSocket message size is 1MB. Reject larger messages.
3. **Session Name Validation**: Session names must match regex `^[a-zA-Z0-9_-]+$` (alphanumeric, underscore, hyphen). Max length 64 characters.

## Data Model

### Control-Plane Database Schema

```sql
-- Agents table
CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    port INTEGER NOT NULL,
    registered_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    status TEXT NOT NULL,  -- 'online', 'offline', 'degraded'
    auth_token_hash TEXT NOT NULL,
    metadata TEXT  -- JSON: tmux_version, os_version, etc.
);

-- Sessions table
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,  -- Format: {agent_id}:{session_name}
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    session_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    status TEXT NOT NULL,  -- 'active', 'detached', 'zombie'
    window_count INTEGER NOT NULL,
    attached_clients INTEGER NOT NULL,
    metadata TEXT  -- JSON: session dimensions, etc.
);

-- Connections table (for tracking active client connections)
CREATE TABLE connections (
    connection_id TEXT PRIMARY KEY,
    client_type TEXT NOT NULL,  -- 'cli', 'web'
    session_id TEXT REFERENCES sessions(session_id),
    connected_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    connection_mode TEXT NOT NULL  -- 'relay', 'p2p'
);

-- Indexes
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_last_heartbeat ON agents(last_heartbeat);
CREATE INDEX idx_sessions_agent_id ON sessions(agent_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_connections_session_id ON connections(session_id);
```

### Metadata Storage

- **Agent metadata**: JSON field storing tmux_version, os_version, rust_agent_version, uptime, load_average
- **Session metadata**: JSON field storing session dimensions (width, height), environment variables (optional), working directory (optional)
- **Configuration**: Stored in TOML files, not in database

## API Contracts

### WebSocket Message Format

All WebSocket messages use JSON format with the following structure:

```json
{
  "type": "message_type",
  "id": "unique_message_id",
  "timestamp": 1234567890,
  "payload": { ... }
}
```

### Agent ↔ Control-Plane Messages

**Agent Registration**
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
      "rust_agent_version": "0.1.0"
    }
  }
}
```

**Agent Heartbeat**
```json
{
  "type": "agent.heartbeat",
  "id": "msg_002",
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

**Session Update**
```json
{
  "type": "agent.session.update",
  "id": "msg_003",
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

### Client ↔ Control-Plane Messages

**List Agents**
```json
{
  "type": "client.agents.list",
  "id": "msg_010",
  "timestamp": 1234567890,
  "payload": {}
}
```

**List Sessions**
```json
{
  "type": "client.sessions.list",
  "id": "msg_011",
  "timestamp": 1234567890,
  "payload": {
    "agent_id": "agent_abc123"  // Optional: filter by agent
  }
}
```

**Attach Session Request**
```json
{
  "type": "client.session.attach",
  "id": "msg_012",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "preferred_mode": "p2p"  // or "relay"
  }
}
```

**P2P Connection Info** (from control-plane to client)
```json
{
  "type": "client.connection.p2p_info",
  "id": "msg_013",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "agent_ip": "192.168.1.10",
    "agent_port": 8080,
    "connection_token": "temp_token_for_p2p"
  }
}
```

### I/O Streaming Messages

**Terminal Input** (client → agent)
```json
{
  "type": "terminal.input",
  "id": "msg_100",
  "timestamp": 1234567890,
  "payload": {
    "session_id": "agent_abc123:dev-work",
    "data": "ls -la\n"  // Raw terminal input
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

### Protocol Versioning

- Protocol version included in registration: `"protocol_version": "1.0"`
- Control-plane rejects agents with unsupported protocol versions
- Minor version changes (1.0 → 1.1) are backward compatible
- Major version changes (1.x → 2.0) require migration

## Constraints

### Technical Constraints

1. **Language**: Rust for all components (agent, control-plane, CLI client). Web UI may use TypeScript/JavaScript for frontend.
2. **Communication**: WebSocket for all real-time bidirectional communication (agent ↔ control-plane, client ↔ agent, client ↔ control-plane). TLS/WSS encryption required for all WebSocket connections, even in intranet deployment.
3. **Network topology**: Pure intranet deployment for v1. All components can reach each other directly. P2P connections use direct IP:port communication (no NAT traversal needed in intranet).
4. **Authentication**: Token-based (static tokens stored in configuration files for v1). Tokens transmitted over encrypted channels (TLS/WSS). No token storage on disk by clients (in-memory only).
5. **Storage**: Lightweight embedded database (SQLite) for control-plane metadata. No external database dependencies. Database schema versioned for future migrations.
6. **Tmux version**: Support tmux 2.6+ (covers most modern Linux distributions). Agent must verify tmux version at startup and reject unsupported versions.
7. **Operating System**: Linux only for agent and control-plane (x86_64 and aarch64). Web UI runs in modern browsers (Chrome, Firefox, Safari, Edge).
8. **Deployment**: Single binary deployment for agent and control-plane. Systemd service files provided for Linux deployment. No containerization required for v1 (Docker optional).

**Scalability Clarification**: v1 targets single control-plane instance supporting up to 100 agents and 1000 concurrent sessions. Architecture should be designed to allow future horizontal scaling (stateless control-plane, externalizable state) but actual clustering is out of scope.

### Performance Constraints

1. **Latency**: < 100ms end-to-end (keyboard to screen) in relay mode; < 50ms in P2P mode.
   - **Measurement methodology**: Measure from client sends input message to client receives output message containing that input's effect. Test on 1Gbps LAN with < 1ms network latency. Measure over 1000 keystrokes, report P95 and P99 latency. Exclude terminal rendering time (measure WebSocket round-trip only).
2. **Throughput**: Single control-plane instance supports 100+ agents and 1000+ concurrent sessions. Each control-plane instance handles 1000+ concurrent WebSocket connections.
3. **Scalability architecture**: v1 is single control-plane instance. Architecture must be designed to allow future horizontal scaling (stateless control-plane, externalizable state to Redis/PostgreSQL) but actual clustering and multi-instance deployment are out of scope for v1.
4. **Resource usage**: Agent should use < 50MB RAM and < 5% CPU (measured as 1-minute average) when idle (managing 10 sessions with no active I/O). With 100 active sessions and moderate I/O (10KB/s per session), agent should use < 200MB RAM and < 20% CPU.

### Operational Constraints

1. **Deployment**: Single binary deployment for agent and control-plane. No complex setup or dependencies beyond tmux.
2. **Monitoring**: Basic health endpoints and logging for operational visibility.
3. **Configuration**: File-based configuration (TOML or YAML). No external configuration services required.

## Success Criteria

### Functional Success

1. **Core operations work**: User can create, list, attach to, and kill tmux sessions on remote machines through both CLI and Web UI.
2. **Multi-agent support**: At least 10 agents can register to a single control-plane and be managed simultaneously.
3. **Hybrid connectivity**: Both relay and P2P connection modes work; system automatically selects the best available mode.
4. **Reconnection**: If a client disconnects (network issue, laptop sleep), reattaching to the same session restores the terminal state without data loss.

### Performance Success

1. **Latency**: P95 latency < 100ms in relay mode, < 50ms in P2P mode (measured as WebSocket round-trip from client input to client output on 1Gbps LAN, excluding terminal rendering).
2. **Throughput**: System handles 100 agents and 1000 concurrent sessions without degradation (defined as: P95 latency remains < 100ms, no dropped input, no message queue backlog > 1000 messages).
3. **Agent overhead**: Agent uses < 50MB RAM and < 5% CPU (1-minute average) when managing 10 idle sessions. With 100 active sessions: < 200MB RAM and < 20% CPU.

### Operational Success

1. **Deployment time**: New agent can be deployed and registered in < 5 minutes on a fresh Linux VM (measured from SSH access to agent appearing in control-plane session list).
2. **Independence**: A single operator can deploy, monitor, and maintain the system using only the provided documentation and CLI tools. No specialized knowledge required beyond basic Linux administration.
3. **Web UI usability**: Web UI is usable on mobile devices (phone/tablet with screen width ≥ 375px) for basic operations (list sessions, attach, send commands). Terminal is readable and input works with touch keyboard.

### Failure Criteria (What Would Make This a Failure)

1. **Cannot operate independently**: System requires more than 2 hours of operator time per week for routine maintenance (excluding feature development), or requires specialized knowledge not available in provided documentation.
2. **Latency too high**: P95 end-to-end latency > 500ms sustained over 1 hour of normal usage (measured as WebSocket round-trip).
3. **Cannot scale horizontally**: Adding more than 50 agents causes P95 latency to exceed 200ms, or requires architectural changes to codebase (not just configuration).
4. **Web UI is unusable**: More than 30% of operations require falling back to CLI because Web UI is broken, incomplete, or unusable on mobile devices.

## Edge Cases

### Agent-Side Edge Cases

1. **Tmux not installed**: Agent should detect missing tmux at startup and exit with clear error message.
2. **Tmux server crash**: Agent should detect tmux server failure, attempt restart, and re-register with control-plane.
3. **Session name conflicts**: tmux does not allow duplicate session names on the same agent. If client requests a session name that already exists, agent should return an error. Clients should use unique session names or append timestamps/UUIDs.
4. **Session attach conflicts**: Multiple clients attach to same session simultaneously. All should receive I/O stream (tmux supports multiple clients natively).
5. **Agent process crash**: Agent should clean up registered sessions on control-plane before exiting. If crash is unclean, control-plane should mark agent as offline after heartbeat timeout.

### Control-Plane Edge Cases

1. **Agent disappears without cleanup**: Control-plane marks agent as offline after heartbeat timeout (default 30s). Clients connected to that agent receive disconnection notification.
2. **Control-plane restart**: Agents automatically reconnect and re-register. Clients automatically reconnect. Session metadata restored from database.
3. **Relay overload**: If control-plane relay becomes bottleneck, it should prioritize P2P connection establishment and suggest clients switch to P2P.
4. **Metadata corruption**: Control-plane should validate metadata on load and reject corrupted entries (log warning, continue with valid entries).

### Client-Side Edge Cases

1. **Network interruption during attach**: Client should automatically attempt reconnection. On reconnect, restore terminal state (resize, scrollback if possible).
2. **Concurrent attach from multiple clients**: All clients should receive I/O stream. Input from any client is forwarded to session (tmux handles this natively).
3. **Web UI browser tab close**: Should not affect session on agent. Reopening Web UI allows reattach.
4. **Mobile device rotation**: Web UI should handle viewport resize gracefully without losing session state.

### Connectivity Edge Cases

1. **P2P connection fails**: System should automatically fall back to relay mode without user intervention.
2. **Relay and P2P both fail**: Client receives clear error message with troubleshooting steps (check network, check agent status).
3. **Slow network**: System should degrade gracefully (lower frame rate for terminal updates) rather than crash or hang.
4. **Firewall blocking WebSocket**: Clear error message suggesting network configuration changes.

## Open Questions

1. **Session output buffering**: How much terminal output should be buffered for late-joining clients? (Recommendation: last 1000 lines of scrollback)
2. **P2P connection establishment**: Use WebSocket relay to exchange connection info (like WebRTC signaling), or use a separate protocol? (Recommendation: WebSocket relay for simplicity)
3. **Web UI framework**: Which frontend framework? (Recommendation: React + xterm.js for terminal emulation, or Svelte for smaller bundle size)
4. **Heartbeat interval**: How often should agents report to control-plane? (Recommendation: 10s default, configurable)
5. **Session metadata**: What metadata to store? (Recommendation: session name, creation time, agent ID, window count, active window, attached client count)
6. **Token management**: Static tokens in config file, or generate tokens via API? (Recommendation: Static tokens in v1, API-generated tokens in v2)
7. **Logging**: What to log and where? (Recommendation: Structured JSON logs to stdout, log level configurable per component)

## Appendix: Architecture Overview

```
┌─────────────┐         ┌─────────────────┐         ┌─────────────┐
│   Client    │◄───────►│  Control-Plane  │◄───────►│ Local Agent │
│ (CLI/WebUI) │         │   (Hub/Relay)   │         │  (Tmux Host)│
└─────────────┘         └─────────────────┘         └─────────────┘
      │                                                   ▲
      │              P2P Direct Connection                │
      └───────────────────────────────────────────────────┘
```

**Components**:
- **Local Agent**: Runs on tmux host machines, manages tmux sessions, reports to control-plane
- **Control-Plane**: Central coordinator, agent registry, connection broker, relay fallback
- **Client**: CLI tool or Web UI for interacting with tmux sessions

**Connection Modes**:
- **Relay Mode**: Client → Control-Plane → Agent (all traffic flows through control-plane)
- **P2P Mode**: Client → Agent (control-plane only facilitates initial connection setup)

**Data Flow**:
- Agent registers with control-plane on startup, sends periodic heartbeats
- Client connects to control-plane, requests session list
- Client requests attach to specific session
- Control-plane brokers connection (P2P if possible, relay as fallback)
- Client streams I/O with agent (and optionally control-plane in relay mode)
