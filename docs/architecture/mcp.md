# MCP Access Layer (`#565`)

Nession exposes its existing Session/Agent capabilities to external AI clients
through [MCP](https://modelcontextprotocol.io). MCP is an **application access
layer**, not another Protocol Unit: it reuses the business services the Web,
CLI and Server already run, and it serves the same tool definitions regardless
of where it is hosted.

```text
MCP client ── Streamable HTTP /mcp ──▶ nession-mcp
                                         │
                        ┌────────────────┴────────────────┐
                        │                                 │
                 Standalone host                 Embedded host
             (remote Server/Agent)        (Server or Agent services)
```

## The crate

`crates/nession-mcp` provides:

- the MCP Streamable HTTP lifecycle (`2025-03-26`), JSON-RPC handling,
  `initialize`, sessions and `tools/list` / `tools/call`;
- the single tool catalog and input schemas;
- argument validation and result/error projection;
- inbound bearer-token authentication and a fail-closed configuration check;
- `ClusterBackend` / `NodeBackend` traits;
- a standalone binary, `nession-mcp`.

It does **not** depend on `nession-server` or `nession-agent`. The host crates
implement the two backends and inject them; `nession-client` is an optional
dependency used by out-of-process backends.

## Tools

The names state the semantic owner. A hosting mode never changes a name,
schema or result shape.

| Semantic owner | Tool | Existing operation |
|---|---|---|
| Server cluster | `nession_server_list_agents` | `server.agent.list` |
| Server cluster | `nession_server_list_sessions` | `server.session.list` (`agent_id`, `force`) |
| Server cluster | `nession_server_get_info` | `server.info` |
| Server cluster | `nession_server_capture_session_preview` | `server.session.capture-preview` |
| Server cluster | `nession_server_get_session_attach_info` | non-secret projection (does **not** call `server.session.attach`) |
| Server cluster | `nession_server_create_session` | `server.session.create` |
| Server cluster | `nession_server_kill_session` | `server.session.kill` |
| Server cluster | `nession_server_rename_agent` | `server.agent.rename` |
| Server cluster | `nession_server_delete_agent` | `server.agent.delete` |
| Agent node | `nession_agent_list_sessions` | `agent.session.list` |
| Agent node | `nession_agent_create_session` | `agent.session.create` |
| Agent node | `nession_agent_kill_session` | `agent.session.kill` |

`nession_server_*` always answers from the Server's registry/routing, even when
it carries an `agent_id` filter. `nession_agent_*` always requires an explicit
`agent_id`; there is no implicit "this host" fallback. A missing or mismatched
id is an argument error.

`nession_server_get_session_attach_info` returns the session, agent, status and
advertised endpoints. It **never** returns a Server-minted P2P credential: the
tool is a read, and the projection has no credential field to redact.

## Hosting modes

### Standalone

```bash
nession-mcp --config /etc/nession/mcp.toml
```

`--config` takes a path; `NESSION_MCP_CONFIG` supplies one when the flag is
absent, and `mcp.toml` is the default.

```toml
[mcp]
listen_address = "127.0.0.1:9090"
auth_token = "<mcp-inbound-token>"

[backend.server]
endpoint = "wss://nession.example.com/ws"
auth_token = "<server-token>"

# Optional: direct management of one standalone Agent for nession_agent_*.
[backend.agent]
endpoint = "ws://127.0.0.1:19091/ws"
auth_token = "<agent-operator-token>"
agent_id = "agent-…"
```

- `[backend.server]` is required: cluster tools must reach a real Server.
- `[backend.agent]` is optional. Without it the catalog still lists the agent
  tools, and each call reports that no Agent backend is configured.
- The inbound token and the backend tokens are separate. The inbound token is
  never forwarded to a backend.
- After binding, the program prints `nession-mcp listening on <addr>` on
  stdout (logs go to stderr). This is what makes `listen_address =
  "127.0.0.1:0"` usable by a supervisor or test.
- `[mcp] tls_cert_path` / `tls_key_path` optionally serve the MCP listener over
  TLS; public deployments should use TLS or a TLS-terminating proxy.
- `SIGINT`/`SIGTERM` stops accepting and drops in-flight connection tasks.

### Server embedded

```toml
server_auth_token = "<server-token>"

[mcp]
enabled = true
```

The Server mounts `/mcp` on its existing listener (no second port). Cluster
tools dispatch through the same `server_routes!` table a Web/CLI connection
uses; node tools route to the named Agent through the existing command broker.
The inbound token is the Server's `auth_token`; enabling MCP with an empty token
refuses to start (fail closed).

`[mcp] path`, `tool_timeout_secs` and `max_concurrent_calls` are also
available. `listen_address`, `auth_token` and the TLS fields are
standalone-only and ignored by an embedding host.

### Agent embedded

```toml
agent_token = "<agent-token>"

[mcp]
enabled = true
```

The Agent mounts `/mcp` on its P2P listener. Its local tools use the Agent's
own `SessionManager`; cluster tools reuse the Server the Agent reports to
(`server_url`/`auth_token`). The inbound token is `agent_token` — the same
configured token a standalone Agent already uses for its P2P socket. This does
**not** widen P2P authorization: the MCP bearer check is independent, and a
Server-connected Agent's P2P credentials are still Server-minted.

In standalone mode (`server_url` empty) the cluster tools remain listed and
return a structured "standalone Agent has no Server backend" error. Local tools
keep working — this is the Server-offline path.

## Transport and authentication

- Endpoint: `POST /mcp` (configurable path), MCP Streamable HTTP revision
  `2025-03-26`. Responses are JSON; the server does not offer a GET SSE stream
  (405), and `DELETE /mcp` terminates an MCP session.
- Every request must carry `Authorization: Bearer <token>`. Missing and wrong
  tokens are both `401` with `WWW-Authenticate: Bearer`.
- `initialize` negotiates the version and assigns `Mcp-Session-Id`; subsequent
  requests must present it (`404` for an unknown/terminated session).
  `notifications/initialized` marks the session ready.
- Tool execution is bounded by `tool_timeout_secs` and
  `max_concurrent_calls`. A backend refusal is returned as a `tools/call`
  result with `isError: true`, not as a JSON-RPC transport error.
- Tokens never appear in a tool schema, argument, result or log.

## Configuration limits

- MCP is disabled by default (`[mcp] enabled = false`).
- Enabled with no inbound token is a startup error, not an anonymous endpoint.
- The Server's empty-token WebSocket mode does not make MCP anonymous.

## Deferred

Real-time terminal attach / PTY I/O, env and quick-command management tools, and
MCP resources/prompts remain out of scope for this phase. The read-only preview
and the non-secret attach projection are included.
