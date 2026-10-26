# Session and tmux SDK ownership

Status: **target frozen for #2469, slice 0**. The code has not moved yet;
slices 1–5 migrate it. This document is the canonical owner for the
Session/tmux ownership boundary and the migration contract.

Related owners:

- [`agent-tmux-control-transport.md`](agent-tmux-control-transport.md) — the
  Control Mode `-C`/`-CC` protocol and transport contract. It stays the
  protocol owner; this document does not restate its measured wire rules.
- [`../../crates/nession-agent/AGENTS.md`](../../crates/nession-agent/AGENTS.md)
  — the current executable chokepoint rule for tmux process creation.
- [`../design/terminal/ahp-inspired-terminal-consistency.md`](../design/terminal/ahp-inspired-terminal-consistency.md)
  — accepted terminal epoch/seq/replay/ACK semantics, not reimplemented here.
- [`../design/terminal/stream-replay.md`](../design/terminal/stream-replay.md) —
  the ordered stream, replay and gap-detection contract.
- [`../design/terminal/multi-client-ownership.md`](../design/terminal/multi-client-ownership.md)
  — ControlLease and active-device handoff (#1095/#2286); not restated here.
- [`../design/terminal/session-runtime-ownership.md`](../design/terminal/session-runtime-ownership.md)
  — the **Web-side** SessionRuntime (#1309). The Agent SessionRuntime defined
  here is a different lifetime and does not extend or replace it.

## Target ownership chain

```text
Web / CLI / MCP / central-server connection
  -> Agent SessionService / SessionRegistry
     -> SessionTerminalRuntime (lease, input, ordered stream, subscribers)
        -> Agent TmuxSessionBackend adapter (Nession-specific policy)
           -> nession-tmux (standalone tmux library)
              -> typed Admin/one-shot operation OR persistent TmuxClient
                 -> private tmux server/socket
```

Three rules make the chain a boundary rather than a directory layout:

1. **Only `nession-tmux` constructs tmux processes and encodes tmux command
   grammar.** Every production route — P2P server, central connector, watchers,
   CLI helpers, the legacy plain-PTY backend — goes through it.
2. **Only Agent SessionService owns Session lifecycle** (create, kill,
   discover, environment policy). Transport adapters authenticate, validate a
   contract and call a Session method; they do not mutate Session state.
3. **TerminalRuntime owns ControlLease, input ordering, the one ordered output
   stream and bounded Subscriber state.** A WebSocket handler owns neither the
   backend nor the stream policy.

## Five lifetimes that must not collapse

| Lifetime | Owner | Survives | Identity |
|---|---|---|---|
| Nession Session | Agent SessionService | viewer absence; the tmux Session may outlive the Agent | Nession Session key |
| Agent SessionRuntime / TerminalRuntime | Agent process | WebSocket connections and subscriptions | at most one current runtime per Session key |
| TmuxClient attachment generation | TerminalRuntime | — (replaced on source loss/reattach) | one generation per physical tmux attachment |
| Physical connection | transport adapter | — | authenticated principal; ephemeral |
| Subscription | TerminalRuntime | — (created per attach, removed on detach) | Agent-issued opaque subscription token/generation |

Consequences that are part of the contract:

- **Last subscriber disconnect unsubscribes; it does not kill the tmux
  Session.** Client absence is not source loss and not Session termination.
- **A reconnect does not continue a stream by assertion.** It resumes only
  from a verified stream cursor/applied cursor or starts a truthful bootstrap.
- **A replaced peer is not a slow peer.** Peer replacement and slow-consumer
  eviction have different causes and must not share a close path.
- **Passive reconnect does not take the ControlLease.** Only meaningful
  authorized activation does (#2286).

## Ownership matrix: current state → target

Verified against `main` at the start of slice 0 (`cf5106503`). The original
requirement inventory was taken at `d68252a6`; staging may contain newer
terminal fixes and must be re-read before moving code.

| Current owner | What it owns today | Gap against the target | Target |
|---|---|---|---|
| [`tmux/client/`](../../crates/nession-agent/src/tmux/client/) | Persistent typed `-C`/`-CC` client: framing, ordered event consumer, command FIFO/tombstones, bounded ingress | Depends on Agent test/process helpers; lives in the Agent crate | `nession-tmux::client` |
| [`tmux/cmd.rs`](../../crates/nession-agent/src/tmux/cmd.rs) | `TmuxCmd`: every production tmux process/socket; `TMUX`/`TMUX_TMPDIR` scrubbing; stale-socket healing | Imports `nession_common::tmux_socket`; embeds Nession config/socket resolution | Generic process/socket owner in SDK; Nession resolution stays in Agent composition |
| [`tmux/ops.rs`](../../crates/nession-agent/src/tmux/ops.rs) | Typed one-shot argv: env get/set, window size, pane mode flags, resize, send-keys, capture-pane, detach-by-pid | Mixed with Agent error/policy types | `nession-tmux` operations |
| [`tmux/manager.rs`](../../crates/nession-agent/src/tmux/manager.rs) | list/create/kill, cwd/command queries, memory pressure, Claude binding env, process-env passthrough | Returns `nession_protocol::SessionInfo`; embeds Nession memory/Claude policy | Generic management API in SDK; Nession create/lifecycle/env policy in SessionService |
| [`tmux/env.rs`](../../crates/nession-agent/src/tmux/env.rs), [`tmux/util.rs`](../../crates/nession-agent/src/tmux/util.rs) | Nession env source-script cleanup; availability/version probes | Nession policy inside the tmux layer | Agent owns env binding; SDK owns only tmux-native version/probe operations |
| [`tmux/control.rs`](../../crates/nession-agent/src/tmux/control.rs) | `ControlModeSession`: bootstrap capture barrier, window-size guard, output credit/deadline, resize level | Session-stream policy currently lives beside the SDK client | SDK exposes generic capture/order; Agent adapter owns stream/ACK policy |
| [`tmux/pty.rs`](../../crates/nession-agent/src/tmux/pty.rs), [`tmux/session.rs`](../../crates/nession-agent/src/tmux/session.rs) | Legacy plain-PTY backend and the `TmuxSession` trait | Backend abstraction lives in the Agent | Preserved during migration; process creation moves behind the SDK |
| [`server/websocket.rs`](../../crates/nession-agent/src/server/websocket.rs) | `AgentServer` + Agent-wide `SessionMap`: `AttachedSession { backend, peers, control, stream, input }`, attach/detach, fan-out, lease checks | Network handler owns terminal/session state and the backend; last peer removal closes the backend | Agent SessionService/Registry + TerminalRuntime; adapters only |
| [`server/session_terminal.rs`](../../crates/nession-agent/src/server/session_terminal.rs) | `SessionControlState`, `SessionInputState`, `SessionStreamState` | Good state vocabulary, wrong owner location | TerminalRuntime |
| [`connection/server_client.rs`](../../crates/nession-agent/src/connection/server_client.rs) | Central connection session list/create/kill/env commands over its own `Arc<SessionManager>` | Separate manager instance; no shared SessionService | Calls the one SessionService |
| [`runtime.rs`](../../crates/nession-agent/src/runtime.rs) | Composition root: socket configure, `tmux_for_client`, providers, P2P server, heartbeat, session watcher, git invalidation watcher | Builds **six** production `SessionManager` instances — central/provider manager, `AgentServer`'s own, heartbeat, session watcher, git invalidation watcher, git workdir resolver; no single Agent-wide owner | Construct one SessionService and inject it into every entrypoint/access path |
| [`web/src/platform/socket/clientId.ts`](../../web/src/platform/socket/clientId.ts) | Stable per-origin `client_id` in `localStorage`, sent on `client.auth` | Also used as Terminal peer identity, so two same-origin tabs share it | Keep the auth identity; issue separate Agent connection/subscription identities for Terminal membership |
| [`sync/session_watcher.rs`](../../crates/nession-agent/src/sync/session_watcher.rs), [`sync/heartbeat.rs`](../../crates/nession-agent/src/sync/heartbeat.rs), [`sync/git_invalidation.rs`](../../crates/nession-agent/src/sync/git_invalidation.rs) | Poll tmux for inventory/heartbeat/invalidation | Each holds its own `SessionManager` | Consume SessionService discovery, not a private manager |

## Call-site inventory

### Production tmux process and command construction

The static gate [`scripts/check-tmux-socket.sh`](../../scripts/check-tmux-socket.sh)
already proves the current invariant: only
`crates/nession-agent/src/tmux/cmd.rs` may name `tmux` in a process
constructor, and every shell/TS tmux invocation under `scripts/`, `e2e/`,
`deploy/` and the `justfile` must carry `-S`. The three spawn forms counted are
`Command::new("tmux")`, `Command::new(<expression>)`, and
`CommandBuilder::new(...)`.

Today the complete production chain is:

- `TmuxCmd::tokio()` / `std()` / `pty()` → every one-shot command and every
  Control Mode/plain-PTY attach child;
- `TmuxOps` → one-shot administrative/query grammar;
- `TmuxClient` → persistent Control Mode command encoding;
- `SessionManager` → create/list/kill and cwd/command queries;
- `PtySession` / `ControlModeSession` → attach children.

No other workspace crate spawns tmux. `nession-cli`, `nession-server` and
`nession-client` are protocol clients only: they name tmux in documentation
and wire payloads, not in process code. The Server's Relay path opens a
WebSocket to the Agent's P2P listener, so Relay terminal traffic lands in the
same Agent `agent.terminal.*` handlers as a direct P2P attach — it is not a
second terminal implementation.

### Session-state call sites in the Agent

- `websocket.rs` owns the Agent-wide `SessionMap`
  (`Arc<Mutex<HashMap<String, AttachedSession>>>`) and shares it across P2P
  connections. It is not per-connection state.
- An attach replaces a peer with the same stable `client_id`; the peer's
  pointer identity is the cleanup key, so a stale socket cannot delete its
  successor.
- On connection teardown, peers are removed by pointer identity, the lease is
  released if the holder has no remaining peers, and a session with no peers
  is removed and its backend `close()`d. `TmuxSession::close` terminates the
  **attachment client**, not the tmux Session; `SessionManager::kill_session`
  is the Session-termination authority. The target contract separates these
  more sharply (see SC-06).
- `authorize_mutation(client_id, generation)` treats `generation = None` as
  authorized when the client is the current controller. That is the legacy
  tolerance slice 4 must replace with a versioned strict path, not silently
  keep as the only check.
- Bootstrap capture, fan-out queues, issued credit, output ACK and stream
  replay live in `server/bootstrap.rs`, `server/outbound.rs`,
  `server/issued_credit.rs`, `server/output_ack.rs`, `server/session_terminal.rs`
  and `server/execution.rs`. These are Agent terminal-policy owners and move
  with TerminalRuntime; they are not SDK material.

### Entry points and composition

`runtime.rs` is the composition root, but it currently composes by
construction rather than by ownership: the central `ServerClient`, the
provider registry, `AgentServer`, the heartbeat loop, the session watcher, the
git-invalidation watcher and its workdir resolver each construct their own
`SessionManager` (six production instances). They
resolve the same private socket, so they agree operationally, but no single
object is the Agent's Session owner. Slice 3 replaces this with one injected
SessionService for every entrypoint.

### Test and script owners

Test infrastructure creates isolated tmux servers and must stay outside the
production ownership claim:

- `scripts/tmux-run-socket.sh`, `scripts/filtered-test.sh`,
  `scripts/sweep-test-sessions.sh` create/reclaim per-run sockets;
- `e2e/globalSetup.ts` creates the e2e run socket;
- `crates/nession-agent/tests/integration/main.rs` uses an injected fake tmux
  binary that records argv;
- `crates/nession-agent/tests/integration/control_mode.rs` exercises real
  isolated tmux.

The SDK's own tests must be self-contained: a fake process fixture plus a real
isolated tmux server, with no Nession workspace crate on the dependency graph.

## `nession-tmux` public surface (direction, not final syntax)

The crate is tmux-native. It must be useful to a consumer that has never
heard of Nession.

### Configuration

```rust
// Illustrative names; the invariants are binding.
pub struct TmuxConfig {
    pub binary: PathBuf,          // explicit, never resolved from PATH by accident
    pub socket: PathBuf,          // explicit absolute path; no personal-socket fallback
    pub config_file: Option<PathBuf>,
    pub options: TmuxOptions,
}
```

- The caller supplies the binary, socket and config; the SDK never reads a
  Nession config, environment variable or default socket path.
- An unresolvable/invalid socket is an error. Falling back to tmux's default
  socket is forbidden.
- Nession's resolution (config key, `NESSION_TMUX_SOCKET`, directory
  preparation, stale-socket healing) stays in Agent/CLI composition.

### Two clients, one semantic owner

- **Admin/one-shot client** — exists before any attachment: create/list/kill,
  set/show environment, pane/window queries, capture, resize, detach. Typed
  targets and results; no generic arbitrary-argv escape hatch.
- **Persistent `TmuxClient`** — one ordered source-event consumer per
  attachment, command FIFO with tombstones, bounded ingress, exact
  command-reply matching, timeouts/cancellation, source-loss semantics, safe
  detach/cleanup.
- Both consume one typed tmux-semantic operation definition where the
  operations are genuinely equivalent. Raw pane bytes (`send-keys -H`) are not
  the same operation as textual keys or shell-init lines and must not be
  merged to force a shared signature.
- `-C`/`-CC` remain distinct transports with the same protocol contract; the
  default is `-C + Pipe`, `-CC + PTY` is controlled opt-in, and a failed launch
  never silently falls back.

### Errors and bounds

`TmuxError` must distinguish at least: spawn failure, command error (tmux's own
words), timeout with **uncertain execution** (the command may have run),
source loss, unsupported variant. Every bounded handoff states its budget and
deadline; a stall ends in a stated loss, not a healthy freeze.

### Forbidden knowledge

`nession-tmux` must not depend on or reference `nession-agent`,
`nession-protocol`, `nession-common`, `nession-runtime`, `nession-claude-code`,
`nession-git`, WebSocket/xterm, Claude bindings, Nession Session DTOs, memory
pressure thresholds, Nession env-script lifetime, the fixed 5000-line history
product default, ControlLease, subscription credit, or output-applied ACK
semantics. This includes test-only and dev dependencies.

### Packaging

- Internal crate with `publish = false` and an independent version (for
  example `0.1.0`), not the workspace product version.
- No dependency on non-publishable workspace crates or application-private
  fixtures.
- README, examples (manage sessions; attach/watch output), public API docs,
  and an explicit supported tmux/platform matrix.
- `cargo package` / packaged-tarball consumer check is part of the acceptance
  evidence. Actual crates.io upload, license selection and registry metadata
  are **out of scope** for #2469 and require a separate owner decision.

## Active/idle resource policy

The runtime lifetime is Agent-owned, not WebSocket-owned.

- **Creation:** lazily on first need — create or first attach — exactly one
  TerminalRuntime per Session key.
- **Active:** at least one subscription.
- **Idle:** zero subscriptions. Idle means *no viewers*, not *no tmux Session*
  and not *source loss*.
- **Retention:** an idle runtime keeps its stream state and its existing tmux
  attachment while the tmux Session is alive and the Agent process is running.
  This is deliberate: tearing the attachment down on the last disconnect
  would either kill a Session the user still expects (today's behaviour) or
  create a false continuity claim on the next attach. A retained attachment
  costs one tmux control client and the bounded buffers below.
- **Retirement:** explicit Session kill, tmux source loss, or Agent shutdown.
  There is no implicit idle timeout in slices 3–4. If a later policy adds one,
  it must be explicit, bounded, and must mark continuity unproven on the next
  attach rather than replaying as if nothing happened.
- **Bounds:**
  - one runtime per tmux Session, bounded by the Agent's own Session set;
  - the stream history ring (existing bounded replay window);
  - one bounded output queue and byte budget per Subscriber, with independent
    ACK/credit;
  - one ordered source-event consumer per attachment;
  - no unbounded task per message and no map lock across backend I/O.

## Migration slices

Each slice is a separate focused PR. Do not land one giant refactor.

| Slice | Change | PR base | Proof boundary |
|---|---|---|---|
| 0 | This document: ownership matrix, call-site inventory, SDK API direction, active/idle policy, compatibility and tmux matrix; update scoped instruction links | `main` (docs-only) | Document review; no code movement |
| 1 | Create `crates/nession-tmux`; move Control Mode client, framing, transports, commands, events and self-contained tests; Agent behaviour unchanged through an adapter | `staging` | SDK builds/tests standalone; Agent parity tests |
| 2 | Move `TmuxCmd`/`TmuxOps` and all native create/list/kill/env/capture/resize operations behind the typed SDK API; remove duplicate argv/raw spawn; update the socket Gate | `staging` | Real isolated tmux admin/control Case; gate negative fixtures |
| 3 | Extract SessionService/Registry/TerminalRuntime; move `AttachedSession`, control/stream/input and subscriptions out of `websocket.rs`; one resource owner from `runtime.rs` | `staging` | Cross-entrypoint ownership review; lifecycle tests |
| 4 | Separate Session, attachment generation, connection and subscription identity; exact attach/detach/cleanup, multi-tab broadcast, takeover, source-loss and restart semantics | `staging` | Two-tab/two-device staging Case; source-loss fault Case |
| 5 | Hardening: packaged external consumer, API docs, real `-C`/`-CC` macOS/Linux proofs, selected fault Cases, protocol compatibility, no stale old owner, deployment unchanged | `staging` | Staging Cases bound to exact SHA |

## Compatibility and protocol

- Slices 0–3 do not change the wire. Existing terminal epoch/seq/replay/ACK,
  ControlLease (#2286), capture-cut and aggregate handoff (#2387/#2388)
  contracts are preserved, not re-derived.
- Slice 4 may add versioned identity/generation fields. They go through
  `nession-protocol` versioned contracts and codegen (#678), with mixed-version
  tests. No new wire schema is embedded in the SDK.
- The legacy plain-PTY backend remains selectable until regression parity
  justifies retirement. It may not bypass the SDK's process/socket owner.
- The legacy `authorize_mutation(..., None)` tolerance is retained only for
  the compatibility window; the strict generation path becomes authoritative
  once the versioned contract is negotiated.

## Supported platform and tmux matrix

| Environment | tmux source | Evidence |
|---|---|---|
| Linux CI (unit/integration/e2e) | distribution tmux via `apt-get install -y tmux` on the runner image | Record the actual `tmux -V` in each real-tmux Case artifact; do not assume the runner's version |
| macOS developer host | Homebrew tmux, measured 3.6b | Existing Control Mode measurements and integration tests |
| Unsupported | A transport/variant that is unavailable or fails to launch | Must fail explicitly, never silently fall back |

Minimum version: the current code relies on `-e` session environment injection
(tmux ≥ 3.0) with a set-environment fallback, Control Mode availability, and
measured 3.6b behaviour for `%exit` framing and layout-resize deduplication.
Slice 1 must record the exact minimum it claims and prove it; until then the
supported matrix is "the versions CI and the measured macOS host actually
run", not a wider promise.

## Enforcement

The migration must strengthen, not replace, the existing guards:

| Guard | Current owner | Required after migration |
|---|---|---|
| tmux process/socket chokepoint | `scripts/check-tmux-socket.sh` (`tmux-socket-isolation`) | Chokepoint moves to `crates/nession-tmux`; the old path must have no spawn; negative fixtures updated to the new owner, not deleted |
| SDK dependency isolation | none (new) | Static check that `nession-tmux` has no Nession workspace/application dependency, including dev-dependencies |
| Session-state ownership | review + `server-handler-locality` for Server handlers | No WebSocket handler constructs a tmux client or mutates Session state directly; add a source-level guard if the invariant can be made deterministic |
| Protocol compatibility | `protocol-integrity`, `protocol-codegen-drift`, `protocol-json-contract` | Unchanged; new versioned fields follow the Protocol Kernel |

The existing executable owner stays authoritative until the code moves: no
slice may delete or weaken `scripts/check-tmux-socket.sh` in anticipation of a
future owner.

## Deferred decisions

- crates.io publication, license selection, registry metadata — separate owner
  authorization; not attempted by #2469.
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
