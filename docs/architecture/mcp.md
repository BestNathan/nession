# MCP Access Layer (`#3264`)

Nession exposes a small set of **business capabilities** to AI clients through
[MCP](https://modelcontextprotocol.io). MCP is an application access layer, not
another Protocol Unit: it calls the owners the Web, CLI and runtime already
have, and the same Tool keeps one name, schema and error contract in every
hosting mode.

The semantic owner of a Tool is the owner of the authoritative state or action,
**independent of where the MCP endpoint runs or how the request routes**. The
Protocol routes behind the removed Tool projections still exist and are still
used by the Web, CLI and Server.

Client-side configuration is a different owner: Claude Code's MCP inventory,
scoped management, explicit discovery and the one-click Nession registration
are documented in [claude-code-mcp.md](claude-code-mcp.md). That integration
reads and writes Claude's configuration; it does not add or change a Tool here.

```text
MCP client ── Streamable HTTP /mcp ──▶ nession-mcp
                                         │
                        ┌────────────────┴────────────────┐
                        │                                 │
                 Standalone host                 Embedded host
          (Server routing, or explicit     (Server or Agent services)
           direct-Agent mode)
```

## Tools

The baseline catalog has eleven Tools:

| Semantic owner | Tool | Operation |
|---|---|---|
| Server | `nession_server_list_agents` | `server.agent.list` (registry discovery) |
| Server | `nession_server_env_list` | `server.env.list` (Server and online-Agent file metadata) |
| Server | `nession_server_env_get` | `server.env.get` (read raw file content) |
| Server | `nession_server_env_write` | `server.env.write` (create/overwrite with in-use guards) |
| Server | `nession_server_env_delete` | `server.env.delete` (delete with in-use guards) |
| Server | `nession_server_session_env_binding_get` | `server.session.env.binding.get` (desired + observed state) |
| Server | `nession_server_session_env_binding_set` | `server.session.env.binding.set` (whole ordered replacement, revision CAS) |
| Server | `nession_server_session_env_binding_reapply` | `server.session.env.binding.reapply` (re-resolve at a new revision) |
| Agent | `nession_agent_list_sessions` | the named Agent's live Session state |
| Agent | `nession_agent_create_session` | `agent.session.create` on the named Agent |
| Agent | `nession_agent_kill_session` | `agent.session.kill` on the named Agent |

A host that composes Extension contributions (`#3778`) advertises them after
these under the same typed contract.

`nession_server_list_agents` answers from the Server's registry — registration,
heartbeat and advertised addresses — not from a live query of an Agent. The
`nession_agent_*` Tools always require an explicit, non-empty `agent_id`; there
is no implicit "this host" fallback, and a missing, empty or mismatched target
is refused rather than redirected.

### Removed Tools

These MCP projections were removed (`#3264`). Their **underlying Protocol
routes and Web/CLI behavior are unchanged**; only the MCP names are gone.

| Removed MCP Tool | Use instead |
|---|---|
| `nession_server_list_sessions` | `nession_agent_list_sessions` with an explicit `agent_id` |
| `nession_server_get_info` | no MCP replacement (Server diagnostics stay on the Web/CLI) |
| `nession_server_capture_session_preview` | no replacement: shell observation is a future capability contract, not a preview alias |
| `nession_server_get_session_attach_info` | no MCP replacement (attach is an interactive terminal action) |
| `nession_server_create_session` | `nession_agent_create_session` |
| `nession_server_kill_session` | `nession_agent_kill_session` |
| `nession_server_rename_agent` | no MCP replacement |
| `nession_server_delete_agent` | no MCP replacement |

No MCP Tool mints or returns a P2P credential, and no removed Tool added a
second management control plane.

## Tool contract: mandatory input and output schemas

Every Nession-owned Tool declares **both** a typed `inputSchema` and a typed
`outputSchema` (`#3735`). The external MCP specification makes `outputSchema`
optional for interoperability; Nession's own Tool contract does not. A Tool
cannot register, be advertised by `tools/list`, be exported to Pages or be
considered implemented without one.

Both schemas are derived with `schemars` from the same Rust types the Tool and
its semantic backend use:

| Tool owner | Successful reply type | Schema source |
|---|---|---|
| Server discovery | `WebAgentsListResponse` | Protocol contract |
| Server ENV | `ClientEnvListResponsePayload` / `ClientEnvGetResponsePayload` / `ClientEnvWriteResponsePayload` / `ClientEnvDeleteResponsePayload` | Protocol contract |
| Server Session ENV binding | `ClientSessionEnvBindingResponsePayload` | Protocol contract |
| Agent Session kill | `SessionKillResponse` | Protocol contract |
| Agent Session list | `SessionListOutput` + `SessionSummary` | Tool module |
| Agent Session create | `SessionCreatedOutput` | Tool module |

The Agent Session list/create replies have one MCP projection because the three
hosting modes reach the same Agent truth through different Protocol wires (the
Agent's `agent.session.list` reply, the Server broker's copy of it, and the
Server's `server.session.list` projection). The Tool advertises only fields
every route can state truthfully; route-specific fields stay in that route's
own Protocol contract.

`ToolHandler::output_schema` is required, and `ToolRegistry::build` rejects an
empty map or a generic object placeholder (`{ "type": "object" }`, an empty
`properties`, or a field with no type/structure). Host adapters return the typed
reply — they deserialize a Server/Agent wire reply into it or construct it from
their own services — so an untyped owner reply cannot become a successful Tool
result.

A successful `tools/call` result carries the reply both as text content and as
MCP `structuredContent` conforming to the declared `outputSchema`. Text and
structured content are the same JSON value. A business refusal or tool error is
`isError: true` and carries **no** `structuredContent`: the output schema
describes success only, and an error never masquerades as a conforming success
result. The source-pinned exporter, semantic digest, publication validation and
Documents reader all require and hash both schemas; a missing or malformed
output contract fails publication.

## Flat Tool structure

```text
crates/nession-mcp/src/
├── lib.rs
├── service.rs             # protocol/transport adapter, auth, deadlines
├── catalog.rs             # McpCatalog: immutable generations, explicit swap
├── provider.rs            # McpToolProvider: Extension-contributed Tools
├── registry.rs            # ToolRegistry: register/list/lookup/call
├── tool.rs                # ToolHandler / ToolContext contracts
├── backend.rs             # semantic backend seams
├── error.rs
├── protocol.rs            # claimed versions and endpoint defaults
├── http.rs                # standalone HTTP host request classification
└── tools/
    ├── mod.rs             # module declarations + baseline registration ONLY
    ├── nession_server_list_agents.rs
    ├── nession_agent_list_sessions.rs
    ├── nession_agent_create_session.rs
    └── nession_agent_kill_session.rs
    ├── env_target.rs           # shared source/agent target and Session identity validation
    ├── nession_server_env_list.rs
    ├── nession_server_env_get.rs
    ├── nession_server_env_write.rs
    ├── nession_server_env_delete.rs
    ├── nession_server_session_env_binding_get.rs
    ├── nession_server_session_env_binding_set.rs
    └── nession_server_session_env_binding_reapply.rs
```

Every Tool is **one file named exactly like the MCP Tool**, flat under
`tools/` in its owning crate (no `tools/server` or `tools/agent` directories).
The module owns its name, description, typed argument contract, typed success
output contract, emitted JSON Schemas and focused tests; each schema is
generated from the same `serde` type the Tool parses or returns, so
`additionalProperties: false` and runtime validation cannot drift.
`tools/mod.rs` only declares modules and registers the baseline handlers with
one `ToolRegistry`; there is no central `match name` dispatch and no automatic
or macro registration. A contributed Tool follows the same one-file contract
in its Extension's crate.

The baseline `ToolRegistry` is built **once at service startup**. The advertised
catalog is one immutable generation: those baseline Tools plus, on a host that
composes Extension contributions, the Tools each explicitly listed
`McpToolProvider` (see `crates/nession-mcp/src/provider.rs`) returns. A
generation is built and validated in full before it becomes visible — a
provider that cannot enumerate its Tools, a name claimed by multiple semantic
owners, or a missing/placeholder output contract rejects the update and leaves
the previous generation in place. Only an explicit host reconfiguration
(Extension install/enable/disable/reconfigure, an incompatible schema change or
a capability-manifest update) atomically swaps generations and advances the
monotonic revision; `tools/list` and `tools/call` only read the current
generation and never re-enumerate a provider. An unknown Tool call is a
tool-level argument error, not a transport failure. A host may omit an
unconfigured optional backend's Tools only by an explicit, tested policy; a
temporarily offline target keeps the Tool listed and answers with a truthful
unavailable error, never a changed identity or schema.

### Extension-contributed Tools (`#3778`)

The Extension owns a contributed Tool's semantics and its typed contract; the
owning Agent composes the `McpToolProvider` explicitly and executes the Tool;
the Server remains the authority for Agent discovery, authorization and
routing; `nession-mcp` owns MCP protocol, catalog validation, authentication,
concurrency, deadlines and result shape. There is **no** separate MCP server per
Extension and no second Session management plane. `nession-mcp` never depends
on `nession-agent`, `nession-server`, `nession-common` or a concrete provider,
and a provider is never reached by side-effect registration. Live runtime state
— a Session appearing, an Extension switching between idle and busy, a
transient disconnect — is not a catalog mutation.

An Agent advertises its contributions in `server.agent.register` as a typed
`McpToolManifest` (`mcp_tool_manifest`): the exact name, owning provider,
description, input schema and output schema of each contributed Tool. The
manifest is derived from the same catalog the Agent's embedded endpoint serves,
so it cannot advertise a Tool the Agent cannot execute. The Server validates it
— supported manifest version, one contract per Tool name across the fleet, a
required `agent_id` argument, a typed output contract — and merges the
compatible Tools into its own catalog generation. A refused manifest leaves the
previous generation live and is logged; the Agent still registers and serves
its Sessions. `server.mcp.tools.list` exposes the validated merged manifest (a
standalone host adopts it at startup); `server.mcp.tool.call` and
`agent.mcp.tool.call` carry one explicitly targeted call.

Every contributed call names a non-empty `agent_id` in its own arguments.
Server-embedded and Server-routed standalone hosts broker it to exactly that
Agent through the canonical Agent route; direct-Agent standalone mode uses the
P2P unit; an Agent-embedded host executes only Tools its own catalog
advertises. An offline Agent keeps its Tools listed and answers `unavailable`;
an unknown Agent, or a Tool absent from that Agent's validated manifest, is
`not_found`. There is never a cross-Agent fallback.

Each catalog generation has a monotonic revision, exposed as
`_meta["nession/catalogRevision"]` on `tools/list`. Only an explicit manifest
install/removal or host reconfiguration advances it; a reconnection that
advertises an unchanged manifest does not rebuild the catalog, and no Session,
Extension-runtime or connection-state change triggers one. A connected legacy
session receives `notifications/tools/list_changed` after an explicit change. A
stateless `2026-07-28` request has no notification channel and observes the new
revision and definitions on its next `tools/list`, bounded by the advertised
TTL. The source-pinned static export (Pages/Documents) is built from the
baseline registry, never from a runtime manifest: a dynamic Agent capability
can change what an endpoint advertises, never the Rust-owned contract source
that publication verifies.

`McpService` owns the protocol lifecycle, transport, inbound authentication,
Origin policy, body size, concurrency and deadlines. A handler only validates
arguments and executes the business operation through the injected
`ToolContext`.

## Backend and routing contract

| Hosting mode | Server-owned discovery, ENV and binding tools | `nession_agent_*` |
|---|---|---|
| Server embedded | Server registry via the real `server_routes!` dispatch | the unnamed target is routed to the named Agent through the Server's command broker |
| Agent embedded | the configured Server (or an explicit "standalone Agent" unavailable error) | this Agent's local `SessionManager`, refusing any other `agent_id` |
| Standalone, Server routing (default) | configured Server | **through the Server's canonical Agent route**, after the Server registry confirms the target is online |
| Standalone, direct Agent (explicit) | configured Server | the one configured Agent's P2P endpoint, refusing any other `agent_id` |

ENV is managed through the Server's canonical `server.env.*` routes. The
`source` argument defaults to `server`; for `source=agent` an explicit
`agent_id` is required. The Server's existing rules protect files bound to
running Sessions; writes are create-only by default (`overwrite=false`),
and forced overwrite/deletion requires `force=true`. The `get` operation
returns raw file contents, which may contain credentials: MCP callers must
treat them as secrets and not put them into logs or unrelated prompts.
Agent-embedded MCP without a configured Server returns an unavailable error
for Server-owned ENV tools; it never silently substitutes local Agent state.

Session Environment Binding is its own Server-owned capability. The three
binding Tools route through the same `server.session.env.binding.*` units the
Web uses, never through an Agent-local tmux path. `get` reports the desired
revision, the ordered profiles with outdated flags, the Agent-observed
revision/status and the managed key **names** — never values or snapshots.
`set` replaces the whole ordered selection (an empty list clears it) and
`reapply` re-resolves the current selection at a new revision; both require
`expected_revision`, which the Server applies as a durable compare-and-swap. A
stale value is refused with `revision_conflict` before any durable or
Agent-side mutation, and there is no `force`/`ignore_conflict` bypass: the
caller re-reads with `get`. Saving an ENV file never changes a running
Session's materialized revision; only an explicit reapply or a replacement
does. Agent-embedded MCP without a Server fails these Tools with an
unavailable error rather than mutating local tmux through a second path.

The Agent owns Session lifecycle and live state even when a caller reaches it
through the Server. The Server owns Agent discovery, authorization and routing.
There is no Server-local tmux fallback and no alternate management plane. The
inbound MCP token is verified by the hosting endpoint and never forwarded to a
backend; no Tool mints or returns a P2P credential.

## Protocol versions

The service is **dual-era** and claims exactly two versions, both with executed
acceptance proof:

| Version | Lifecycle |
|---|---|
| `2026-07-28` (primary) | stateless: no `initialize`, no `notifications/initialized`, no `Mcp-Session-Id`; every request declares its version, client identity and capabilities in `_meta` |
| `2025-03-26` (legacy) | `initialize` negotiates the version, the server assigns `Mcp-Session-Id`, and the session is terminated with `DELETE /mcp` |

### `2026-07-28`

- `server/discover` reports the supported versions, capabilities and server
  identity; clients may call it before any other request but are not required
  to.
- Every POST carries `MCP-Protocol-Version`, which must match
  `_meta.io.modelcontextprotocol/protocolVersion`, plus `Mcp-Method` equal to
  the JSON-RPC method. `tools/call` additionally carries `Mcp-Name` equal to
  `params.name`. A missing or mismatched header is `400` with JSON-RPC code
  `-32020` (`HeaderMismatch`).
- A version the server does not implement is `400` with `-32022`
  (`UnsupportedProtocolVersionError`) and `data.supported` listing the two
  versions above. There is no fake modern negotiation over a legacy lifecycle.
- Tool parameters may be mirrored into `Mcp-Param-{Name}` headers through the
  `x-mcp-header` schema extension. The validation mechanism is implemented and
  tested; none of the baseline Tools annotates a parameter today, so none
  requires such a header.
- `tools/list` carries `ttlMs` and `cacheScope: private`: the catalog changes
  only on an explicit host reconfiguration, never per request, and is not
  shared across authorization contexts.
- GET and DELETE on the MCP endpoint are `405`; no session is minted or echoed.

### `2025-03-26`

Legacy clients keep the initialize handshake and the `Mcp-Session-Id`
lifecycle, including the GET SSE stream and session `DELETE`. The server selects
the era from how the client opens; the two eras can be served concurrently on
the same endpoint. A request that omits `MCP-Protocol-Version` is treated as
`2025-03-26`, which is what pre-`2025-06-18` clients send.

### Transport ownership

The wire grammar — version negotiation, standard-header mirroring and
validation, `server/discover`, legacy sessions and SSE — comes from the official
Rust [`rmcp`](https://github.com/modelcontextprotocol/rust-sdk) SDK. Nession
keeps its own flat ToolHandler/ToolRegistry and does not adopt SDK macros or
the SDK's tool registry.

Embedded hosts mount the SDK's Streamable HTTP service as an explicit route on
their Axum router (`#3439`): the Agent's `/mcp` path sits beside its P2P upgrade
on the same listener, and the Server's beside `/ws` and the authorized blob
route. The listener's HTTP grammar, routing and WebSocket Upgrade belong to
Axum; the MCP endpoint keeps its own path check, Bearer authentication, Origin
and Host policy. The standalone `nession-mcp` binary owns its own listener and
still drives the shared service through hyper.

### Abandoned MCP mutation requests

The MCP service bounds request execution, but a timeout is **not** proof that a remote Session mutation was rolled back. Agent- and Server-embedded Session create/kill share their owner's keyed mutation lane. The request/worker pair uses a one-way admission guard: dropping an MCP request while its operation is queued atomically marks it abandoned, so the queued work skips the side effect when it reaches its turn. Once the worker has claimed execution, a later MCP timeout cannot retract the already-started business operation. The caller receives a timeout with explicit readback-before-retry guidance; it must inspect current Agent Session state rather than assume a failed write or automatically repeat it. The guard does not add a Session state owner, retry daemon or new Tool. Remote backend timeouts are likewise not evidence of rollback.

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

# Optional: bypass Server routing and manage one Agent directly.
[backend.agent]
endpoint = "ws://127.0.0.1:19091/ws"
auth_token = "<agent-operator-token>"
agent_id = "agent-…"
```

- `[backend.server]` is required. It serves Server-owned discovery and, when
  `[backend.agent]` is absent, the default route for Agent-owned Session tools.
- `[backend.agent]` is optional and explicit. It names one Agent and its
  operator token; there is no implicit fallback between direct and routed mode.
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

The Server mounts `/mcp` on its existing listener (no second port). Server-owned
discovery dispatches through the same `server_routes!` table a Web/CLI
connection uses; Agent-owned Session Tools route to the named Agent through the
existing command broker. The inbound token is the Server's `auth_token`; an Agent Token is
refused. Enabling MCP with an empty token refuses to start (fail closed).

### Agent embedded

```toml
agent_token = "<agent-token>"

[mcp]
enabled = true
```

The Agent mounts `/mcp` on its P2P listener. Its local Tools use the Agent's own
`SessionManager`; Server-owned discovery reuses the Server the Agent reports to
(`server_url`/`auth_token`). The inbound token is the Agent's durable
`agent_token` (#3440) — the same endpoint-owned secret the P2P listener
verifies, so MCP and direct P2P share one authentication contract. The Server
Token is refused here, and the Agent Token is refused by the Server's MCP
endpoint.

In standalone mode (`server_url` empty) the Server-owned Tool remains listed and
returns a structured "standalone Agent has no Server backend" error. Local Tools
keep working — this is the Server-offline path.

### Shared `[mcp]` options

`path` (default `/mcp`), `tool_timeout_secs`, `max_concurrent_calls`,
`allowed_origins` and `allowed_hosts` are available to every host. The last two
bound browser and Host-header access; see below. `listen_address`, `auth_token`
and the TLS fields are standalone-only and ignored by an embedding host.

## Transport, authentication and limits

- Endpoint: `POST /mcp` (configurable path).
- Every request must carry `Authorization: Bearer <token>`. Missing and wrong
  tokens are both `401` with `WWW-Authenticate: Bearer` and no diagnostic body.
  Authentication is fail-closed: MCP enabled with an empty token refuses to
  start.
- **Origin policy:** a request carrying an `Origin` header must match
  `[mcp] allowed_origins` (RFC 6454 scheme/host/port). The default list is
  empty, which refuses every present browser Origin — the DNS-rebinding
  boundary. Requests without `Origin` (ordinary MCP clients) pass.
- **Host policy:** `[mcp] allowed_hosts` defaults to the listener's own host plus
  loopback. An unspecified bind (`0.0.0.0`/`::`) cannot derive a finite list, so
  the Host check is disabled there; bearer authentication and the Origin policy
  remain mandatory.
- Request bodies are bounded (4 MiB), request heads are read with a deadline,
  and tool execution is bounded by `tool_timeout_secs` and
  `max_concurrent_calls`. A backend refusal is a `tools/call` result with
  `isError: true` whose text is `{"error":{"kind":…,"message":…}}` — the same
  shape in every hosting mode — not a JSON-RPC transport error.
- Tokens never appear in a Tool schema, argument, result or log.

## Configuration limits

- MCP is disabled by default (`[mcp] enabled = false`).
- Enabled with no inbound token is a startup error, not an anonymous endpoint.
- The Server's empty-token WebSocket mode does not make MCP anonymous.

## Not provided

The service does not advertise or implement Nession Resources, Prompts, Tasks,
MRTR-driven tool interactions, subscriptions, terminal PTY streaming, env
management, quick commands, terminal previews or attach flows. It claims only
the base semantics of the two protocol versions above and does not advertise
optional capabilities it does not implement. No MCP Tool mints or returns a P2P
credential.

### OCI image defaults (#3705)

The Server and Agent OCI image entrypoints mount their **existing embedded**
MCP endpoint at `/mcp` by default. Native host configs still default to
disabled. A single `deploy/render-mcp-config.sh` emits the OCI-only table.

Set `NESSION_MCP_ENABLED=false` in the container environment, Compose or
GitOps for emergency rollback; only literal `true` and `false` are valid.
The Server requires an operator-managed inbound `SERVER_AUTH_TOKEN` when MCP
is on, or exits before nginx starts. The Agent MCP endpoint reuses its durable
inbound Agent Token (operator `AGENT_TOKEN` or runtime-provisioned); the
outbound `AGENT_AUTH_TOKEN` does **not** authorize inbound MCP calls.
No token is embedded in the image or printed in logs.

The image's nginx `:10080/mcp`, and configured Server TLS `:443/mcp`,
forward to the same embedded service, without Web HTML fallback. Authorization,
Origin, MCP-Protocol-Version and Mcp-Session-Id are passed through, with SSE
buffering disabled. A smoke probe initializes via POST /mcp, calls tools/list
and a safe read; unauthorized calls must return 401. Public exposure requires
TLS or a trusted TLS-terminating proxy. The source and prebuilt image paths
copy the same entrypoint, nginx template and renderer; no separate MCP
process or listener is launched.

Compose intentionally carries no published Agent default bearer token. Set
`AGENT_TOKEN` to a unique secret to select your own, or leave it unset to use
the Agent's durable token provisioned under `NESSION_HOME` (`/data` in Compose).
Never publish a shared fixture token on an exposed MCP port.

### Standalone OCI image (#3791)

The standalone host is also published as its own image role, independently of
Server/Agent. It is the `nession-mcp` program and `StandaloneConfig` above —
this image adds no MCP runtime, Tool, transport, routing or configuration
owner. It coexists with the embedded mode (#3705) because the two answer the
same question for different topologies: embedded serves MCP from a Server or
Agent that already exists; standalone lets an MCP access layer be deployed,
versioned, scaled, stopped and rolled back on machines that run no Server or
Agent.

**Artifact.** `Dockerfile.mcp.prebuilt` packages only the architecture-matched
`nession-mcp` binary on `debian:bookworm-slim` with CA certificates and a
`curl` liveness probe. The `mcp-bin` build context uses `cargo zigbuild` for
`linux/amd64` and `linux/arm64`; the build fails if the binary is absent or its
ELF machine does not match the target architecture. The image carries no
Server/Agent binary, nginx, Web bundle, tmux, EROFS helper, Sandbox launcher,
Node/Claude toolchain, configuration or token. It runs as uid/gid 10001 with
no writable state and exposes port `9090`; the binary remains PID 1 and its
existing `SIGTERM` handling drains connections.

**Release identity.** CI publishes the same workspace version family:
`mcp-<short-sha>` from a staging push and `mcp-<workspace-version>` from a
production release, each a multi-arch OCI index with `amd64`/`arm64` platform
manifests and `org.opencontainers.image.revision` set to the exact source SHA.
The staging build-provenance document and the authenticated staging source
verifier include `mcp`; the ACR mirror lane copies the already-published index
and records its digest. A missing or failed MCP image job fails publication and
deployment verification rather than being silently skipped. The image is
**not** added to the Server/Agent/UI GitOps kustomizations: GitOps rollout rules
are unchanged by this role.

**Configuration and security.** Mount an operator-managed document read-only at
`/etc/nession/mcp.toml` (the default), or pass `--config` /
`NESSION_MCP_CONFIG`. Start from `deploy/mcp.example.toml`; its required
credentials are empty so an unedited document fails closed. In a container,
bind `0.0.0.0:9090` and state `allowed_hosts` explicitly for any public
ingress; with an unspecified bind the Host allowlist is disabled, while the
inbound bearer token and Origin policy stay mandatory. MCP clients do not send
an `Origin` header; a browser client must be named in `allowed_origins`.
Terminate TLS at a trusted proxy or configure the listener's
`tls_cert_path`/`tls_key_path`. The inbound MCP token is distinct from every
outbound credential and is never forwarded. `[backend.server]` (the real
Server's `/ws` endpoint and credential) remains required; `[backend.agent]` only
narrows the Agent target. Absent, unparsable or incomplete configuration exits
before serving.

**Health.** The image health check only asks the listener for an HTTP response
(a `401` without a token counts, because it proves the process is alive). It
does not authenticate, does not call a Tool and does not report remote-backend
readiness; a Server outage surfaces as `tools/call` errors.

**Independent lifecycle.** `deploy/docker-compose.mcp.yml` is a standalone
Compose sample with profile `mcp`, a read-only configuration bind, dropped
capabilities and a required image reference. It is not a service in
`deploy/docker-compose.yml`, so `docker compose up` never installs MCP with
Server/Agent. Deploy it on a separate machine, Compose project or Kubernetes
workload with its own Secret, ingress and lifecycle. Roll back by pinning a
previous `mcp-*` tag or, preferably, an immutable digest; no Server/Agent/UI
rollout changes are required.
