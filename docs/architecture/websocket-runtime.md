# WebSocket Runtime Architecture

How one physical WebSocket carries **control**, **requests** and **real-time
streams** in Nession, who owns each part of that path, and what the runtime
must guarantee at its bounds.

This is the canonical architecture owner for Requirement
[#4431](https://github.com/BestNathan/nession/issues/4431) and its delivery
packages:

| Package | Issue | Owns |
|---|---|---|
| Architecture + integrated proof | [#4431](https://github.com/BestNathan/nession/issues/4431) | this document, route inventory, cross-package integration |
| Bounded ingress, Control/Request execution | [#4433](https://github.com/BestNathan/nession/issues/4433) | reader admission, task supervision, execution budgets |
| Classified outbound and settlement | [#4434](https://github.com/BestNathan/nession/issues/4434) | writer, class scheduler, pending/connection settlement |
| Stream dispatch and resource fences | [#4435](https://github.com/BestNathan/nession/issues/4435) | stream classes, flow control, session fences |
| Knowledge ingestion | [#4436](https://github.com/BestNathan/nession/issues/4436) | curated knowledge publication |
| Stability telemetry | [#4437](https://github.com/BestNathan/nession/issues/4437) | metric contract, instruments, baseline, dashboards |

The protocol vocabulary — Protocol Units, wire categories, manifests,
resolution — is owned by [`protocol.md`](protocol.md). This document is about
the **runtime** that carries that protocol over a socket; it does not rename,
redefine or duplicate a protocol concept.

> **Status.** This document records the current implementation *and* the
> approved target where they differ. Sections say which is which. The target
> is not a claim about merged behavior; each statement becomes current only
> when its owning package lands and the integrated proof in #4431 SC-03 passes.

## 1. Two orthogonal classifications

The protocol and the runtime classify messages for different reasons and must
not be collapsed into one enum.

```text
Protocol Kernel category          Runtime dispatch domain
(consumer-visible naming)         (scheduling and ownership)

Operation                         Control     fast, bounded, resolved in place
Notification         ────────▶    Request     bounded concurrent/keyed work
Control                           Stream      ordered/recoverable/coalesced data
```

- **Protocol category** answers *who may send it and who answers it*. It is
  derived from the wire name and enforced by `scripts/protocol-gate.mjs` and
  the route declarations (`docs/architecture/protocol.md` § *The three wire
  categories*).
- **Dispatch domain** answers *how the socket schedules it, what bounds it and
  which owner settles it*. It is provider-owned metadata declared beside the
  route, not inferred from a wire prefix or from untrusted peer priority.

The two are orthogonal. `agent.terminal.output` is a Notification by protocol
category and a Stream by dispatch domain. `agent.terminal.output.applied` is an
Operation/Request that is also stream flow control. `control.heartbeat` is a
Control wire *and* a Control dispatch. A query is an Operation dispatched as a
Request. Nothing about this table adds a second consumer-visible contract
registry: the domain is an execution property, never a wire contract.

## 2. One reader, one writer, one owner

Per physical socket — Server client/agent socket, Agent P2P socket, Agent
central-server socket, Relay leg — the runtime has:

```text
socket ──▶ Reader ──▶ decode ──▶ auth gate ──▶ provider policy ──▶ admit/refuse
                                                                     │
                                                  Control / Request / Stream
                                                                     │
socket ◀── Writer ◀── classified frames ◀── fair bounded scheduler ◀─┘
```

Invariants:

1. **One reader.** Frames are decoded and classified on one task. Business
   work does not run in the reader; a slow handler must not stop heartbeat,
   completion or stream processing.
2. **One writer.** Every outbound frame on a physical socket is serialised by
   one writer task with one queue set. Two writers on one socket interleave
   bytes and are never acceptable.
3. **One resource owner.** A Session, pending request, subscription or
   connection generation has one owner. Adapters translate; they do not keep a
   second map of the same state.
4. **No untrusted priority.** Dispatch class, resource key and authority come
   from provider declarations and the host's authenticated context. A peer
   cannot choose its scheduling class by wire naming, payload field or arrival
   convention.
5. **Bounded everywhere.** Count *and* bytes are bounded per connection and
   per process: in-flight tasks, retained task records, queued work, pending
   requests, active connections, stream windows and oversized frames.
6. **Explicit overload.** Work is admitted atomically or refused before it is
   accepted. The runtime never silently drops a request that a caller is
   waiting on, and never lets an unbounded queue absorb a stalled peer.
7. **Exactly-once settlement.** EOF, transport error, close, stall and
   shutdown settle both halves, their tasks and their registrations once,
   generation-fenced. A stale generation cannot settle a newer owner.

The transport itself is owned as `protocol.md` states: Axum owns the upgrade
and the HTTP listener (`nession_runtime::ingress`); `WsFrame` is the
transport-neutral frame vocabulary; `tokio-tungstenite` is confined to the
Relay's and Agent's private outbound clients.

## 3. Dispatch domains

| Domain | Typical members | Admission | Ordering | Termination |
|---|---|---|---|---|
| **Control** | `control.heartbeat`, `control.ping`, `control.pong`; `client.auth`/`server.auth`; `server.agent.register`; RPC completions (`server.agent.command-response`); mode transitions (`server.session.attach`, `server.session.relay.begin/end`) | bounded reserved capacity; never waits behind business work | auth/register and mode transitions fence dependent work | completion or connection loss; control has no acknowledgement |
| **Request** | operations declared `Query` or `Key`/mutation in a route table; extension command units | bounded concurrent (query) or per-key (mutation); refused explicitly when saturated | FIFO within a resource key; independent across keys; ordered barrier only where declared | caller receives an outcome or a connection-loss semantic; no blind replay of side effects |
| **Stream** | `agent.terminal.output`; terminal input (`agent.terminal.input`); `client.terminal.output.progress`; resumable stream operations; latest-state notifications | per-stream finite frame/byte window, separate from Request permits | reliable input is ordered; output is sequenced | provider-owned recovery: ACK/progress, cursor, replay or coalescence; overflow is explicit |

### Control

Control is the small, fast domain. It is admitted from reserved capacity so a
saturated Request lane cannot starve heartbeat, authentication, registration,
completion resolution or a mode transition. The reader performs no slow
business await for it.

- Authentication and registration are ordered against dependent work: nothing
  read after them may run under an identity the frame predates.
- RPC responses are correlated by validated identity, `id` and generation
  **before** ordinary dispatch. A late or duplicate response cannot settle a
  different request; a stale generation cannot settle a newer one.
- A mode transition may wait outside the reader while fencing dependent
  operations. Authentication is never bypassed and closing always settles.
- Control work is bounded. Database, tmux or network work does not run inline
  on the reader.

### Request

Requests are the work a caller waits for.

- Admission is atomic and non-blocking: accepted, refused with an explicit
  overload outcome, or closed. Waiting for a business permit inside the reader
  is the current behavior (see §11) and is the target's *replaced* behavior,
  not a pattern to copy.
- Count and byte limits include queued, running, retained and pre-admission
  work. An accepted request receives an outcome or the connection's loss
  semantics; a refused request is told so before it is accepted.
- Mutations are keyed by the resource they mutate and are FIFO within that key.
  The key is provider-declared from the operation's own payload; it is not
  derived from the wire name.
- No blind replay: side effects are never retried by the runtime. A caller
  correlates and decides.

### Stream

Streams are real-time data whose delivery contract differs from a one-shot
request.

- **Reliable ordered input** (terminal keystrokes, resize): loss-intolerant,
  ordered, never silently dropped, never blindly replayed.
- **Recoverable sequenced output** (terminal bytes, logs): gap detection with
  the provider's existing sequence/checkpoint and replay path.
- **Latest-state coalescence** (state pushes): the newest value for one
  incarnation/key replaces older pending ones; a value from an incompatible
  incarnation is never merged.
- Stream admission has its own finite window, separate from Request permits,
  so a blocked Request lane cannot block terminal input and a flooding stream
  cannot consume ordinary request capacity.
- A slow subscriber is isolated; overflow is an explicit refusal or connection
  recovery using existing sequence/ACK semantics, not a silent truncation.
- Session-level fences — kill/create, control-lease transfer, sandbox/pane
  transition, resize ordering — reject or serialise stale input at the
  resource owner. No second Session owner is introduced.

## 4. Adapter ownership

The mechanisms are shared (`nession-runtime`); the policies and the handlers
are the host's.

### Server (`crates/nession-server`)

- Route declaration: `server_routes!` in `server/handler/routes.rs` — one
  invocation emits the manifest descriptors, the wire set and the dispatcher.
  Every arm carries its execution policy between version and body.
- Reader dispatch: `server::execution` owns what `Ordered`, `Inline`, `Query`
  and `Key` mean, and the barrier in front of ordered frames.
- Mutations use the runtime's shared keyed lane; only the per-connection
  admission bound is the connection's.
- Authentication (`server.auth`), agent registration and attach/relay
  transitions are `Ordered`. Relay traffic the Server does not own is
  `Inline`: the Server cannot state a scheduling policy for another provider's
  operation.
- Teardown: `handle_ws_stream` is the single settlement owner
  (`protocol.md` § *Server connection lifecycle*).

### Agent central connection (`crates/nession-agent`)

- Route declaration: `core_routes!` in `connection/server_client.rs`.
- Default for a wire this connection does not serve is `Query`, not the
  reader: an extension command unit is a request with an answer waiting.
- `client.auth` is handled by the reader before the route table.
- Control wires are handled beside the table; they are not arms and are not
  advertised as units.

### Agent P2P socket (`crates/nession-agent`)

- Route declaration: `p2p_routes!` in `server/websocket.rs`. Each arm also
  carries its access scope (`P2pAccess`) beside the execution policy, so a
  wire cannot gain a lane without a scope.
- Terminal input/output, attach/detach, control acquire and stream resume are
  keyed by the session they name. File mutations share the single
  `ResourceKey::Filesystem` because a rename/recursive delete is not a
  path-scoped operation.
- The Agent owns per-subscriber output flow, the terminal stream identity and
  replay/checkpoint state, and the Session resource transitions.
- Listener admission (pre-authentication) is separate from execution
  admission (`P2pHandshakePolicy`).

### Relay (Server → Agent forwarding)

The Relay is an **adapter**, never a second Session or stream owner.

- It forwards the wire the client named, after verifying the target Agent's
  manifest carries that unit and a compatible version. Unknown or unsupported
  units are refused with a correlated reply; a target with no manifest is
  refused rather than guessed at.
- It does not synthesise frontier, cursor, generation or authority, and it
  does not classify a forwarded message as its own. Input batching and order
  are preserved; negotiated capabilities are the endpoints'.
- The relay endpoint is Server-owned; the browser expresses a preference, not
  a dial target.

### Web (browser runtime)

The Web has no route table. It is a consumer that names wires, subscribes by
notification name, correlates operation replies by `id`, and owns its reconnect
and stream-cursor behavior. It cannot classify itself into a scheduling domain:
the server or agent that serves it decides.

## 5. Admission, overload and budgets

The layers are distinct and must not be conflated:

1. **Listener admission** — accepted sockets mid-request and the
   pre-authentication window (`nession_runtime::ingress`, `#3439`/`#2653`).
2. **Connection admission** — upgraded-but-unauthenticated sockets.
3. **Execution admission** — Control/Request/Stream work on an authenticated
   connection.
4. **Outbound admission** — classified frames waiting for the writer.

Every layer states a count and a byte bound, and every bound is observable.

- Admission is atomic: a frame is accepted whole or refused whole. A partial
  reservation that is later rolled back must not be observable as capacity.
- Limits include **retained bookkeeping**, not only live work: completed task
  records, pending request entries, closed subscriptions and queued frames all
  count until they are released.
- Refusal uses the existing protocol error envelope where one exists. Where it
  cannot be delivered, the connection is closed explicitly; it is never left
  half-open.
- Process-wide budgets exist beside per-connection ones. One connection
  cannot spend the fleet's budget; the fleet cannot make one connection's
  progress impossible.
- Defaults are configurable and measured. There is no fixed thread pool and no
  hidden unbounded spawn.

## 6. Outbound classes and settlement

The writer consumes classified frames. Classes are not a wire category; they
describe why a frame is queued.

| Class | Members | At the bound |
|---|---|---|
| **Control** | ping/pong, close, auth/register replies, control completions | reserved capacity; must not be starved by stream backlog |
| **Response** | an operation's correlated reply, a brokered answer | waits within a finite budget; never silently dropped; the request fails or the connection closes |
| **Stream** | terminal output, progress, state pushes | finite write/flush deadline; slow peer is isolated; terminal/session semantics decide whether to coalesce, drop-with-recovery-signal or close |

Rules:

- Byte and frame accounting include the frame currently being written and
  reservations held by producers. An oversized frame is charged honestly (at
  least the whole budget it exceeds), never silently clamped to look smaller.
- Scheduling is fair and bounded: a bounded control burst, response protection
  and byte-aware stream scheduling. No promise to preempt a write already in
  flight; physical TCP head-of-line blocking is acknowledged, not wished away.
- Every write, flush and close has a finite deadline. An unhealthy socket is
  closed and the reason reaches the read side independently of reader activity.
- The lifecycle supervisor settles both halves, their tasks and their
  registrations exactly once on EOF, error, close, stall or shutdown,
  generation-fenced. Abort/cancel is safe even while admission is parked.
- Pending requests settle exactly once for response, timeout, cancellation,
  delivery failure, replacement or disconnect. A stale generation or a late /
  duplicate reply cannot settle another request. Side effects are never
  retried automatically.
- Relay half-open detection and detach behavior (`#4065`, `#3547`) are
  preserved.

## 7. Lifecycle

```text
accept ─▶ upgrade ─▶ auth deadline ─▶ authenticated ─▶ teardown
                                           │
                      reader ends ─────────┤ (EOF / error / close / stall / shutdown)
                                           ▼
              settle lanes (Control → Request → Stream)
              settle pending requests + registrations (generation-fenced)
              stop writer (finite grace, then abort)
              unregister attachment / release broker lease
```

A Session's lifetime is not a connection's. Ending a socket retires the
physical attachment; it does not kill the tmux Session the Agent owns. A
reconnect presents the cached token and keeps its stream cursor, controller
lease and connection generation.

## 8. Observability

#4437 owns the metric contract. The runtime guarantees the **hooks** exist at
the owner of each event; the exporter is optional and never on the message
path.

- Bounded enum labels: runtime, peer, transport, domain, direction, unit,
  version, result, reason. Never session/agent/request/connection IDs, raw
  wires, paths or commands as labels.
- Connection: active, attempts, close reasons, heartbeat gap/RTT, reader
  admission block, write stall/deadline.
- Request: queue wait, handler time, end-to-end, rejection, active keys/tasks,
  pending broker/terminal outcomes.
- Stream: queue bytes, credit/progress lag (units kept apart), coalesce, gap,
  replay, recovery.
- Runtime: used/limit count and bytes, tasks active/unreaped/panic, exporter
  drops. Gauges aggregate correctly across connections; counters and
  histograms are not interchanged.
- A missing collector cannot delay message handling. The exporter queue is
  bounded and drops are counted.

## 9. Current behavior and the approved target

The baseline is main at `e656d1f9c95baafc8735a2bb0274f668a2cc30d7` (the
Requirement's baseline). The target is the V2 packages. Where a row says
"current", the code is the authority; this table records the delta the
packages exist to close.

| Concern | Current (baseline) | Target |
|---|---|---|
| Reader admission | `QueryLane::dispatch` / `KeyedLane::enqueue` wait on a semaphore when full; the reader is the waiter (`nession-runtime/src/lane.rs`) | non-blocking `admit(validated envelope, provider policy, generation)` returning accepted/refused/closed; explicit overload outcome |
| Completed task records | `JoinSet` retains finished entries until `drain`/`shutdown`; no steady-state reaping in the read loop | continuously reaped; bounded retained records; panic/cancel outcomes recorded |
| Global mutation budget | per-key depth per connection; the shared lane's worker budget is optional and the Server's key worker budget is unbounded | explicit runtime/connection/operation budgets, fair share, no nested indefinite permit waits |
| Inline business work | `Inline` arms may perform business writes in the reader | expensive synchronous work has its own budget; missing unsafe policy fails closed |
| Outbound queue | one queue per socket carries every semantic send (Server 8 MiB, P2P 4 MiB, 64 frames); the Agent central response channel is `AGENT_RESPONSE_QUEUE_SLOTS = 32` | explicit Control/Response/Stream queues with reserved capacity and process aggregate accounting |
| Writer stall | the Agent central writer awaits `sink.send` inside a `select!` arm, so a stalled write delays the shutdown arm; the Server writer is a separate task | finite write/flush/close deadline; unhealthy socket closes; read side notified independently |
| Stream admission | stream output has per-subscriber slots; the general request/stream budget boundary is not explicit | per-stream finite window separate from Request permits; explicit overflow; slow subscriber isolation |
| Settlement | teardown is ordered per Server connection; pending-map replacement/disconnect outcomes are not uniform | one generation-fenced supervisor settles both halves, tasks, pending entries and registrations exactly once |
| Telemetry | lane/queue snapshots and broker counters exist at owners | bounded enum contract + instruments + reproducible baseline (#4437) |

These are described as findings, not as defects in every case: some are
deliberate current tradeoffs. The target changes them because the integrated
mixed-load proof (#4431 SC-03) requires the stronger invariant.

## 10. Route inventory (exact source)

The tables below are the canonical inventory of every wire the three route
declarations serve. They are **derived from the declarations** and verified by
`scripts/websocket-route-inventory.mjs` (`./gates/run
websocket-route-inventory`):

- every served wire appears exactly once with its declared execution policy;
- an inventoried wire that no declaration serves is a failure;
- a policy that differs from the declaration is a failure;
- the negative self-test proves an undocumented wire and a stale row are
  detected.

This is an inventory of execution, not a second protocol registry. The
manifest, descriptors and version resolution remain the Protocol Kernel's.

### Server

<!-- websocket-route-inventory:server -->
| wire | policy |
| --- | --- |
| `server.agent.address-update` | `Inline` |
| `server.agent.command-response` | `Inline` |
| `server.agent.delete` | `Inline` |
| `server.agent.git-invalidated` | `Inline` |
| `server.agent.list` | `Query` |
| `server.agent.register` | `Ordered` |
| `server.agent.rename` | `Inline` |
| `server.agent.session-activity` | `Inline` |
| `server.agent.session-env-binding` | `Inline` |
| `server.agent.session-update` | `Inline` |
| `server.agent.terminal-resize` | `Inline` |
| `server.auth` | `Ordered` |
| `server.commands.add` | `Inline` |
| `server.commands.list` | `Query` |
| `server.commands.remove` | `Inline` |
| `server.commands.update` | `Inline` |
| `server.env.delete` | `Key(env_file_key(payload))` |
| `server.env.get` | `Query` |
| `server.env.list` | `Query` |
| `server.env.write` | `Key(env_file_key(payload))` |
| `server.image.build` | `Inline` |
| `server.image.build.cancel` | `Inline` |
| `server.image.build.get` | `Query` |
| `server.image.build.list` | `Query` |
| `server.image.build.retry` | `Inline` |
| `server.image.build.submit` | `Inline` |
| `server.image.get` | `Query` |
| `server.image.impact.get` | `Query` |
| `server.image.library.list` | `Query` |
| `server.image.list` | `Query` |
| `server.image.tag.remove` | `Inline` |
| `server.image.tag.set` | `Inline` |
| `server.info` | `Query` |
| `server.mcp.endpoint` | `Query` |
| `server.mcp.tool.call` | `Query` |
| `server.mcp.tools.list` | `Query` |
| `server.project.create` | `Inline` |
| `server.project.delete` | `Key(project_by_id(payload))` |
| `server.project.get` | `Query` |
| `server.project.list` | `Query` |
| `server.project.update` | `Key(project_by_id(payload))` |
| `server.session.attach` | `Ordered` |
| `server.session.capture-preview` | `Query` |
| `server.session.create` | `Key(session_by_parts(payload))` |
| `server.session.env.active` | `Query` |
| `server.session.env.apply` | `Key(session_by_id(payload))` |
| `server.session.env.binding.get` | `Query` |
| `server.session.env.binding.reapply` | `Key(session_by_id(payload))` |
| `server.session.env.binding.set` | `Key(session_by_id(payload))` |
| `server.session.env.query` | `Query` |
| `server.session.env.unset` | `Key(session_by_id(payload))` |
| `server.session.kill` | `Key(session_by_id(payload))` |
| `server.session.list` | `Query` |
| `server.session.metadata.get` | `Key(session_by_id(payload))` |
| `server.session.metadata.patch` | `Key(session_by_id(payload))` |
| `server.session.metadata.update` | `Key(session_by_id(payload))` |
| `server.session.processes` | `Query` |
| `server.session.project.set` | `Key(session_by_id(payload))` |
| `server.session.relay.begin` | `Ordered` |
| `server.session.relay.end` | `Ordered` |
| `server.session.sandbox.context` | `Query` |
| `server.session.sandbox.enter` | `Key(session_by_id(payload))` |
| `server.session.sandbox.focus` | `Key(session_by_id(payload))` |
| `server.session.sandbox.image-prepare` | `Key(session_by_id(payload))` |
| `server.session.sandbox.preflight` | `Query` |
| `server.session.sandbox.return-to-native` | `Key(session_by_id(payload))` |
| `server.workspace.create` | `Key(session_by_id(payload))` |
| `server.workspace.delete` | `Key(session_by_id(payload))` |
| `server.workspace.list` | `Query` |
<!-- /websocket-route-inventory:server -->

### Agent central connection

<!-- websocket-route-inventory:agent-central -->
| wire | policy |
| --- | --- |
| `agent.env.delete` | `Key(env_file_by_name(&msg.payload))` |
| `agent.env.get` | `Query` |
| `agent.env.list` | `Query` |
| `agent.env.write` | `Key(env_file_by_name(&msg.payload))` |
| `agent.mcp.tool.call` | `Query` |
| `agent.session.capture-preview` | `Query` |
| `agent.session.create` | `Key(session_by_name(&msg.payload))` |
| `agent.session.env.binding.get` | `Query` |
| `agent.session.env.binding.set` | `Key(session_by_name(&msg.payload))` |
| `agent.session.kill` | `Key(session_by_name(&msg.payload))` |
| `agent.session.list` | `Query` |
| `agent.session.metadata.get` | `Key(session_by_name(&msg.payload))` |
| `agent.session.metadata.patch` | `Key(session_by_name(&msg.payload))` |
| `agent.session.metadata.update` | `Key(session_by_name(&msg.payload))` |
| `agent.session.processes` | `Query` |
| `agent.session.report` | `Query` |
| `agent.session.sandbox.context` | `Query` |
| `agent.session.sandbox.enter` | `Key(sandbox_session_by_name(&msg.payload))` |
| `agent.session.sandbox.focus` | `Key(sandbox_session_by_name(&msg.payload))` |
| `agent.session.sandbox.image-prepare` | `Key(sandbox_session_by_name(&msg.payload))` |
| `agent.session.sandbox.preflight` | `Query` |
| `agent.session.sandbox.return-to-native` | `Key(sandbox_session_by_name(&msg.payload))` |
| `agent.workspace.create` | `Key(workspace_by_name(&msg.payload))` |
| `agent.workspace.delete` | `Key(workspace_by_id(&msg.payload))` |
| `agent.workspace.list` | `Query` |
<!-- /websocket-route-inventory:agent-central -->

### Agent P2P socket

<!-- websocket-route-inventory:agent-p2p -->
| wire | policy |
| --- | --- |
| `agent.attach` | `Key(session_named(payload_value))` |
| `agent.detach` | `Key(session_named(payload_value))` |
| `agent.file.create-dir` | `Key(ResourceKey::Filesystem)` |
| `agent.file.cwd` | `Query` |
| `agent.file.delete` | `Key(ResourceKey::Filesystem)` |
| `agent.file.list` | `Query` |
| `agent.file.read` | `Query` |
| `agent.file.rename` | `Key(ResourceKey::Filesystem)` |
| `agent.file.write` | `Key(ResourceKey::Filesystem)` |
| `agent.mcp.tool.call` | `Query` |
| `agent.session.capture-preview` | `Query` |
| `agent.session.create` | `Key(session_by(payload_value))` |
| `agent.session.kill` | `Key(session_by(payload_value))` |
| `agent.session.list` | `Query` |
| `agent.session.metadata.get` | `Key(session_by(payload_value))` |
| `agent.session.metadata.patch` | `Key(session_by(payload_value))` |
| `agent.session.metadata.update` | `Key(session_by(payload_value))` |
| `agent.terminal.control.acquire` | `Key(session_named(payload_value))` |
| `agent.terminal.input` | `Key(session_named(payload_value))` |
| `agent.terminal.output.applied` | `Key(session_named(payload_value))` |
| `agent.terminal.resize` | `Key(session_named(payload_value))` |
| `agent.terminal.stream.resume` | `Key(session_named(payload_value))` |
| `client.session.attach` | `Inline` |
| `client.session.create` | `Key(session_by(payload_value))` |
| `client.session.kill` | `Key(session_by_id(payload_value))` |
| `client.sessions.list` | `Query` |
<!-- /websocket-route-inventory:agent-p2p -->

### Wires handled outside a route table

These are served by the same adapters but are deliberately not route arms.
Wires that *are* route arms but belong to the Control or Stream dispatch
domain — for example `server.agent.command-response` (an RPC completion) and
`agent.terminal.output.applied` (reliable-input acknowledgement) — remain in
the tables above with their declared policy; §3 and §4 state their domain.

| wire(s) | Owner | Classification | Why outside the table |
|---|---|---|---|
| `control.heartbeat`, `control.ping`, `control.pong` | Server, Agent central, Agent P2P | Control | Control is symmetric and answered by no single runtime; an arm would advertise a unit that does not exist (`protocol.md` § *Control*) |
| `client.auth` | Agent P2P (reader, before the table) | Control | Authentication is the first protocol frame; it establishes the identity later frames use (`protocol.md` § *Authentication is the first protocol frame*) |
| `agent.terminal.output` | Agent P2P / Relay | Stream (recoverable sequenced output) | A notification, not an operation: nothing answers it |
| `client.terminal.output.progress` | Agent P2P / Web | Stream flow control | Progress is stream credit, not a general RPC |
| `server.agents.changed`, `server.sessions.changed`, `server.commands.changed`, `agent.terminal.resize` | Server outbound | Latest-state / stream notifications | Pushes with no response; declared as `pub const` beside the sender |
| Unknown / unserved wire | Server, Agent central, Agent P2P | Refused or declared default | The Server's tail match answers `Reply(None)`/unknown; Agent central defaults to the `Query` lane; Agent P2P answers `unknown_message_type`; none is guessed from a prefix |

### Relay and Web boundaries

- **Relay**: forwards a client-named wire only after the target Agent's
  manifest proves it carries the unit and a compatible version. It does not
  add a class, a lane or an authority decision of its own.
- **Web**: consumer only. Notification wires are named as strings; operation
  replies are correlated by `id`; stream recovery is the endpoint's contract.

## 11. Invariants to preserve when changing this path

1. One reader and one writer per physical socket.
2. Protocol category and dispatch domain stay orthogonal; do not teach the
   wire name a scheduling meaning.
3. Dispatch class, scope and key are provider-owned declarations beside the
   route; no second user-visible registry and no peer-chosen priority.
4. The reader never awaits slow business work for Control or for admission.
5. Terminal input is loss-intolerant and ordered; terminal output is sequenced
   and recoverable; state pushes coalesce only within an incarnation.
6. Every queue, task record, pending entry, subscription and connection is
   bounded in count and bytes.
7. Overload is explicit; silence is never how a caller learns a bound was hit.
8. A stale generation, identity or epoch cannot settle or mutate a newer
   resource.
9. Relay forwards; it does not become a second owner.
10. Telemetry labels are bounded enums; the exporter never blocks handling.

## Related

- [`protocol.md`](protocol.md) — Protocol Units, wire categories, identity,
  manifests, authentication and the Server connection lifecycle.
- [`terminal-engine.md`](terminal-engine.md) — terminal engine ownership.
- [`session-tmux-sdk-ownership.md`](session-tmux-sdk-ownership.md) — Session
  and tmux SDK boundary.
- [`../design/terminal/ahp-inspired-terminal-consistency.md`](../design/terminal/ahp-inspired-terminal-consistency.md)
  — terminal consistency product contract.
- [`agent-tmux-control-transport.md`](agent-tmux-control-transport.md) —
  control-mode transport tradeoffs.
- Historical evidence (not work packages): #961, #974, #975, #1021, #1645,
  #1925, #3439, #3547, #3548, #4065.
