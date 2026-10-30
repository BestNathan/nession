# Session and tmux SDK ownership

Status: **delivered for #2469 on `staging` at `8461ea4c`**. All six slices are
merged there and the merged-SHA Acceptance run accepted all ten Success
Criteria. `main` receives the implementation with the next release promotion;
paths that exist only on staging are written as code rather than as relative
links so this document stays truthful on both lineages.

This document is the canonical owner for the Session/tmux ownership boundary.
It records the delivered architecture and the rules that must survive future
changes; it is not a migration plan.

Related owners:

- [`agent-tmux-control-transport.md`](agent-tmux-control-transport.md) — the
  Control Mode `-C`/`-CC` protocol and transport contract. It stays the
  protocol owner; this document does not restate its measured wire rules.
- [`agent-process-discovery.md`](agent-process-discovery.md) — the read-only
  Session process-membership contract that consumes `TmuxOps::list_panes`;
  it owns the discovery methods, coverage/fallback truth and redaction.
- [`../../crates/nession-agent/AGENTS.md`](../../crates/nession-agent/AGENTS.md)
  — the executable tmux chokepoint rule for the Agent subtree.
- [`../design/terminal/ahp-inspired-terminal-consistency.md`](../design/terminal/ahp-inspired-terminal-consistency.md)
  — accepted terminal epoch/seq/replay/ACK semantics, not reimplemented here.
- [`../design/terminal/stream-replay.md`](../design/terminal/stream-replay.md) —
  the ordered stream, replay and gap-detection contract.
- [`../design/terminal/multi-client-ownership.md`](../design/terminal/multi-client-ownership.md)
  — ControlLease, subscription identity and active-device handoff
  (#1095/#2286/#2469); not restated here.
- [`../design/terminal/session-runtime-ownership.md`](../design/terminal/session-runtime-ownership.md)
  — the **Web-side** SessionRuntime (#1309). The Agent runtime defined here is a
  different lifetime and does not extend or replace it.

## Ownership chain

```text
Web / CLI / MCP / central-server connection
  -> Agent SessionService / SessionRegistry
     -> Session terminal runtime (AttachedSession: lease, input,
        ordered stream, bounded subscribers)
        -> Agent backend adapters (PtySession / ControlModeSession, Nession policy)
           -> nession-tmux
              -> TmuxOps (typed one-shot) or TmuxClient (persistent -C/-CC)
                 -> private tmux server/socket
```

Three rules make the chain a boundary rather than a directory layout:

1. **Only `nession-tmux` constructs tmux processes and encodes tmux command
   grammar.** Every production route — P2P server, central connector, watchers,
   CLI helpers, the plain-PTY backend — goes through it. The Agent supplies its
   binary, absolute socket and server configuration; it does not spawn tmux.
2. **Only Agent `SessionService` / `SessionRegistry` owns Session lifecycle**
   (create, kill, discover, environment policy, attachment lifetime). Transport
   adapters authenticate, validate a contract and call a Session operation; they
   do not mutate Session state.
3. **The Session terminal runtime owns ControlLease, input ordering, the one
   ordered output stream and bounded subscriber state.** A WebSocket handler
   owns neither the backend nor the stream policy.

## Five lifetimes that must not collapse

| Lifetime | Owner | Survives | Identity |
|---|---|---|---|
| Nession Session | Agent `SessionService` / `SessionRegistry` | viewer absence; the tmux Session may outlive the Agent | Nession Session key |
| Session terminal runtime (`AttachedSession`) | Agent process | WebSocket connections and subscriptions | at most one runtime per Session key |
| tmux attachment / stream generation | Session terminal runtime | — (replaced on source loss, kill or reattach) | stream epoch and one physical tmux attachment |
| Physical connection | transport adapter | — | authenticated browser `client_id` plus the connection's peer token |
| Subscription | Session terminal runtime | — (created per attach, removed on detach or retirement) | page-instance `subscription_id`, falling back to `client_id` for legacy clients |

Consequences that are part of the contract:

- **Last subscriber disconnect unsubscribes; it does not kill the tmux
  Session.** Client absence is not source loss and not Session termination.
- **A reconnect does not continue a stream by assertion.** It resumes only
  from a verified stream cursor/applied cursor or starts a truthful bootstrap;
  a fresh attachment always receives a fresh stream epoch.
- **A replaced peer is not a slow peer.** Peer replacement, explicit detach,
  source loss and slow-consumer eviction are different transitions with
  different cleanup; they must not share a close path.
- **Passive reconnect does not take the ControlLease.** Only meaningful
  authorized activation does (#2286). The lease is held by a **subscription**,
  not by the browser id, so two same-origin tabs do not both become controller.
- **A retired generation cannot write into its successor.** A producer task
  records output only for the stream epoch it read; kill, EOF and shutdown
  retire the generation and close its tmux client.

## Delivered ownership

Verified against staging `8461ea4c`. On `main` these files arrive with the
release promotion; until then `main` still carries the pre-migration layout
described at the end of this section.

| Component | Owner | Responsibility |
|---|---|---|
| tmux process construction, framing, parser, persistent client | `nession-tmux` (`crates/nession-tmux/src/process.rs`, `client/`, `parser.rs`) | Explicit `-S`, environment scrubbing, `-C`/`-CC` transports, ordered command/reply, tombstones, bounded ingress, stale-socket healing |
| typed one-shot administration | `nession-tmux::TmuxOps` (`crates/nession-tmux/src/ops.rs`) | create/list/kill, display-message, set-option, capture, clear-history, environment, resize, pane queries, version |
| Nession socket and server configuration | Agent `crates/nession-agent/src/tmux/cmd.rs` | `configure()` resolves the Nession socket, prepares its directory, writes `nession.conf`, heals a stale socket; `TmuxDep` supplies the SDK command |
| Session policy and backend construction | `crates/nession-agent/src/session/service.rs` | One `SessionManager`; the only place `PtySession` / `ControlModeSession` are attached |
| Session lifecycle state | `crates/nession-agent/src/session/registry.rs` | The only writable owner of the Session map; private lock; attach, subscribe, input, resize, resume, ACK, detach, retirement, shutdown |
| terminal runtime state | `crates/nession-agent/src/session/terminal/runtime.rs` and `state.rs` | `AttachedSession`, subscribers, ControlLease, stream/input state, fan-out and epoch fencing |
| transport adapters | `crates/nession-agent/src/server/websocket.rs` | Authenticate, parse a contract and call registry/service operations; no Session-map or `AttachedSession` access in production code |
| central connector and Relay | Agent P2P listener reached by the Server | Relay opens its own Agent connection and presents the browser id, so terminal traffic uses the same registry as direct P2P |
| composition root | `crates/nession-agent/src/runtime.rs` | Builds one `SessionManager`, `SessionService` and `SessionRegistry` and injects them into every entrypoint, watcher and resolver |
| Web identity | `web/src/platform/socket/clientId.ts` and `subscriptionId.ts` | Stable per-origin browser id plus a page-instance subscription id carried on attach and relay begin |
| stream/replay policy | `crates/nession-agent/src/server/{bootstrap,outbound,issued_credit,output_ack,execution}.rs` | Bootstrap barrier, per-subscriber queues/credit, applied-ACK and stream replay; Agent policy, not SDK material |

The pre-migration layout (kept here only to explain the release boundary) had
`AttachedSession` and the Agent-wide `SessionMap` in `server/websocket.rs`, six
separate `SessionManager` instances, tmux process construction in
`crates/nession-agent/src/tmux/cmd.rs`, and the typed client/operations in the
Agent crate. Slice 5's ownership documentation is the authoritative statement
for the delivered layout; the old paths must not be reintroduced.

## Call-site inventory

### Production tmux process and command construction

`scripts/check-tmux-socket.sh` follows process construction into
`crates/nession-tmux/src/process.rs`; that is the only canonical owner. Every
shell/TS tmux invocation under `scripts/`, `e2e/`, `deploy/` and the `justfile`
must still carry `-S`. The three spawn forms counted are
`Command::new("tmux")`, `Command::new(<expression>)`, and
`CommandBuilder::new(...)`.

The delivered production chain is:

- `TmuxCommand::tokio()` / `std()` / `pty()` → every one-shot command and every
  Control Mode/plain-PTY attach child;
- `TmuxOps` → one-shot administrative/query grammar;
- `TmuxClient` → persistent Control Mode command encoding;
- Agent `SessionManager` → create/list/kill and cwd/command queries through
  `TmuxOps`, plus Nession policy (memory guard, inherited env selection,
  Claude/PS1 bindings, mouse mode);
- `PtySession` / `ControlModeSession` → attach children, constructed only by
  `SessionService`.

No other workspace crate spawns tmux. `nession-cli`, `nession-server` and
`nession-client` are protocol clients only. The Server's Relay path opens a
WebSocket to the Agent's P2P listener, so Relay terminal traffic lands in the
same `agent.terminal.*` handlers as a direct P2P attach.

### Session-state call sites in the Agent

- `SessionRegistry` owns the map; its lock is private and no transport handler
  reads or mutates session state directly.
- A subscription replaces the peer with the same identity: page-instance
  `subscription_id` when stated, otherwise the stable `client_id` (the v1
  compatibility rule). Peer cleanup uses connection pointer identity, so an old
  socket cannot delete its successor.
- On connection teardown, peers are removed by pointer identity, the lease is
  released only when the holder has no remaining peer, and a session with no
  peers is removed and its backend closed. `TmuxSession::close` terminates the
  **attachment client**, not the tmux Session; `SessionManager::kill_session`
  is the Session-termination authority and now also retires the attachment.
- Input and resize authorize the **subscription** the requesting connection
  attached under, keyed by `(client_id, peer_token)`; a frame cannot claim
  another tab's subscription id. The legacy `control_generation: None`
  tolerance is retained for clients that predate generation fencing.
- Bootstrap capture, fan-out queues, issued credit, output ACK and stream
  replay remain Agent terminal-policy owners and move with the terminal
  runtime; they are not SDK material.

### Entry points and composition

`runtime.rs` builds one `SessionManager`, wraps it in one `SessionService` and
one `SessionRegistry`, and injects them into `AgentServer`, the central
`ServerClient`, the provider registry, heartbeat, the session watcher, the git
invalidation watcher and the workdir resolver. No entrypoint constructs its own
tmux manager.

### Test and script owners

Test infrastructure creates isolated tmux servers and stays outside the
production ownership claim:

- `scripts/tmux-run-socket.sh`, `scripts/filtered-test.sh`,
  `scripts/sweep-test-sessions.sh` create/reclaim per-run sockets;
- `e2e/globalSetup.ts` creates the e2e run socket;
- `crates/nession-agent/tests/integration/main.rs` uses an injected fake tmux
  binary that records argv;
- `crates/nession-agent/tests/integration/control_mode.rs` exercises real
  isolated tmux;
- `e2e/acceptance/cases/2469/SC-*` bind the merged-SHA Cases and own their
  private tmux sockets.

The SDK's own tests are self-contained: a fake process fixture plus a real
isolated tmux server, with no Nession workspace crate on the dependency graph.

## `nession-tmux` public surface

The crate is tmux-native and useful to a consumer that has never heard of
Nession.

### Configuration

- `TmuxCommand::new(binary, socket)` requires both explicitly;
  `validate()` rejects a relative socket and `with_config_file()` is the
  caller's choice.
- The caller supplies the binary, absolute socket and optional config; the SDK
  never reads a Nession config, environment variable or default socket path.
- An unresolvable/invalid socket is an error. Falling back to tmux's default
  socket is forbidden.
- Nession's resolution (config key, `NESSION_TMUX_SOCKET`, directory
  preparation, stale-socket healing) stays in Agent composition.

### Two clients, one semantic owner

- **Admin/one-shot client** (`TmuxOps`): exists before any attachment —
  create/list/kill, set/show environment, pane/window queries, capture, resize,
  detach. Typed targets and results; no generic arbitrary-argv escape hatch.
- **Persistent `TmuxClient`**: one ordered source-event consumer per
  attachment, command FIFO with tombstones, bounded ingress, exact
  command/reply matching, timeouts/cancellation, source-loss semantics, safe
  detach/cleanup.
- Both consume one typed tmux-semantic operation definition where the
  operations are genuinely equivalent. Raw pane bytes (`send-keys -H`) are not
  the same operation as textual keys or shell-init lines and are not merged.
- `-C`/`-CC` remain distinct transports with the same protocol contract; the
  default is `-C + Pipe`, `-CC + PTY` is controlled opt-in, and a failed launch
  never silently falls back.

### Errors and bounds

`TmuxError` distinguishes spawn failure, command error (tmux's own words),
timeout with **uncertain execution**, source loss and unsupported variant.
Every bounded handoff states its budget and deadline; a stall ends in a stated
loss, not a healthy freeze.

### Forbidden knowledge

`nession-tmux` must not depend on or reference `nession-agent`,
`nession-protocol`, `nession-common`, `nession-runtime`, `nession-claude-code`,
`nession-git`, WebSocket/xterm, Claude bindings, Nession Session DTOs, memory
pressure thresholds, Nession env-script lifetime, the fixed 5000-line history
product default, ControlLease, subscription credit, or output-applied ACK
semantics. This includes test-only and dev dependencies. The executable guard
is `crates/nession-tmux/tests/independence.rs`.

### Packaging

- Internal crate with `publish = false` and an independent version (`0.1.0`),
  not the workspace product version.
- No dependency on non-publishable workspace crates or application-private
  fixtures.
- README, examples (manage sessions; attach/watch output), public API docs
  built with warnings denied, and an explicit supported tmux/platform matrix.
- The SC-01 Case runs `cargo package`, extracts the `.crate` and builds a
  consumer crate outside the workspace against it. Actual crates.io upload,
  license selection and registry metadata remain **out of scope** and require a
  separate owner decision.

## Active/idle resource policy

The runtime lifetime is Agent-owned, not WebSocket-owned.

- **Creation:** lazily on first need — create or first attach — exactly one
  terminal runtime per Session key.
- **Active:** at least one subscription.
- **Idle:** zero subscriptions. Idle means *no viewers*, not *no tmux Session*
  and not *source loss*.
- **Retention:** an idle runtime keeps its stream state and its tmux attachment
  while the tmux Session is alive and the Agent process is running. Tearing it
  down on the last disconnect would either kill a Session the user still
  expects or create a false continuity claim on the next attach. A retained
  attachment costs one tmux client and the bounded buffers below.
- **Retirement:** explicit Session kill, tmux source loss / backend EOF, or
  Agent shutdown. There is no implicit idle timeout. Each retirement removes
  the attachment, closes its tmux client and states source loss to remaining
  subscribers; the next attach creates a fresh runtime and stream epoch.
- **Bounds:**
  - one runtime per tmux Session, bounded by the Agent's own Session set;
  - the stream history ring (bounded replay window);
  - one bounded output queue and byte budget per subscriber, with independent
    ACK/credit;
  - one ordered source-event consumer per attachment;
  - no unbounded task per message and no map lock across backend I/O.

## Delivery record

The slices landed as separate focused PRs; no giant refactor.

| Slice | Delivered | PR / merge |
|---|---|---|
| 0 | This ownership owner, call-site inventory, SDK direction, active/idle policy, compatibility and tmux matrix | #2479 (docs-only, `main`) |
| 1 | `crates/nession-tmux`: Control Mode client, framing, transports, parser, explicit `TmuxCommand`, socket chokepoint move and self-contained tests | #2481 → staging `e7a109c5e` |
| 2 | Typed admin API (`TmuxOps`) with all create/list/kill/env/capture/resize operations; Agent `SessionManager` keeps Nession policy; real-tmux tests and SC-02 Case | #2485 → staging `615c1c850` |
| 3 | `SessionService` / `SessionRegistry` / terminal runtime extraction; one `SessionManager` from `runtime.rs`; handlers name operations only | #2490 → staging `6c63725d8` |
| 4 | Subscription identity, lease by subscription, multi-tab broadcast, passive-reconnect/observer rules, epoch-fenced output, kill/EOF/shutdown retirement; SC-06/SC-07 Cases | #2494 → staging `3415b134a` |
| 5 | Packaged external consumer, warning-free API docs, guard negative fixtures, real `-C`/`-CC` and burst/Relay Cases; SC-03/SC-08/SC-09 | #2499 → staging `c5ef8b79a` |
| — | Acceptance Case isolation fix (private tmux socket, third-party consumer lint env) | #2500 → staging `8461ea4c` |

Merged-SHA Acceptance: Cases run `40379623077` (SC-01/02/03/06/07/08/09) and
Orchestrator run `40379623514` (SC-04/05/10) accepted all ten criteria.

## Compatibility and protocol

- The migration did not change terminal epoch/seq/replay/ACK, ControlLease
  (#2286), capture-cut or aggregate handoff (#2387/#2388) semantics.
- Slice 4 added **optional** identity fields through `nession-protocol` and
  codegen (#678): `subscription_id` on attach and relay begin, and
  `controller_subscription_id` on the attach reply, acquire reply and
  control-changed notification. Absence preserves the v1 rule: the stable
  client id is the subscription identity and a newer attach of that client
  replaces the older one.
- The legacy plain-PTY backend remains selectable until regression parity
  justifies retirement. It uses the SDK's process/socket owner like every other
  route.
- The legacy `authorize_mutation(..., None)` tolerance is retained for the
  compatibility window; a generation that is stated is always enforced.
- No new wire schema is embedded in the SDK.

## Supported platform and tmux matrix

| Environment | tmux source | Evidence |
|---|---|---|
| Linux CI (unit/integration/e2e/acceptance) | distribution tmux via `apt-get install -y tmux` on the runner image | Real-tmux Cases record the actual `tmux -V` in their evidence; do not assume the runner's version |
| macOS developer host | Homebrew tmux, measured 3.6b | Control Mode measurements and integration tests |
| Unsupported | A transport/variant that is unavailable or fails to launch | Must fail explicitly, never silently fall back |

The supported matrix is what CI and the measured macOS host actually run.
The code relies on `-e` session environment injection (tmux ≥ 3.0) with a
set-environment fallback, Control Mode availability, and measured 3.6b
behaviour for `%exit` framing and layout-resize deduplication. A wider version
promise requires new evidence.

## Enforcement

| Guard | Owner | Invariant |
|---|---|---|
| tmux process/socket chokepoint | `scripts/check-tmux-socket.sh` (`tmux-socket-isolation`) | Only `crates/nession-tmux/src/process.rs` constructs a tmux process; every invocation carries `-S`; negative fixtures live with the gate |
| SDK dependency isolation | `crates/nession-tmux/tests/independence.rs` | No Nession workspace/application dependency or source reference, including dev-dependencies; planted negative fixtures prove the scanner works |
| Session-state ownership | `server-handler-locality` + selftest and the `session` module boundary | No WebSocket handler constructs a tmux client or mutates Session state; the registry lock is private |
| Protocol compatibility | `protocol-integrity`, `protocol-codegen-drift`, `protocol-json-contract` | New fields follow the Protocol Kernel; generated bindings are projections, not a second owner |
| Acceptance evidence | `e2e/acceptance/cases/2469/SC-*` | Cases bind the exact merged SHA, own their tmux sockets and state their evidence |

## Deferred decisions

- crates.io publication, license selection and registry metadata — separate
  owner authorization; not attempted by #2469.
- Multi-pane/window product behavior, a generalized workflow/Channel framework,
  durable exact-once terminal input — non-goals.
- Changing Terminal UX, xterm rendering, or the #170 environment business
  semantics — non-goals.

## References

- #2469 — this requirement.
- #991 — tmux semantics; #2307 — Control Mode client; #575 — explicit socket
  isolation; #1645/#1925 — terminal consistency; #2286 — active-device
  ControlLease; #1619 — shared Agent session streams; #170 — Session
  Environment Binding.
- [tmux Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [Cargo publishing](https://doc.rust-lang.org/cargo/reference/publishing.html)
