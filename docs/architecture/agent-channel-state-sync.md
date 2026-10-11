# Agent Channel State Synchronization (AHP-inspired RFC)

> Requirement: [#1645](https://github.com/BestNathan/nession/issues/1645).
> Status: **proposed**, architecture/design only; no implementation or acceptance implied.
> Research date: 2026-10-11. Reference: [Microsoft Agent Host Protocol](https://github.com/microsoft/agent-host-protocol).
>
> This design complements [protocol.md](protocol.md), [protocol-identity.md](protocol-identity.md), [ai-conversation.md](ai-conversation.md), [terminal stream/replay](../design/terminal/stream-replay.md), [multi-client ownership](../design/terminal/multi-client-ownership.md) and [SessionRuntime ownership](../design/terminal/session-runtime-ownership.md).
> If this RFC and protocol.md disagree about wire naming or versioning, **protocol.md remains authoritative** until a separate approved amendment.

## 1. The part of AHP we want

AHP's useful primitives are:
- **Host authority**: agents and long-running work outlive individual UI/transport connections.
- **Addressable resources**: root catalogue, session, chat, terminal and plugin-specific channels. One logical state owner per channel; clients subscribe lazily.
- **Snapshot + sequenced actions**: an initial immutable state and reducer-compatible changes, sequenced by their authority.
- **Reconciliation**: reversible client-originated state mutations have `confirmedState`, `pendingActions`, and a derived `optimisticState`; the Host echoes or rejects mutations.
- **Recovery**: replay missing authoritative actions if retained; otherwise provide a new snapshot.
- **Separating Harness adapters**: provider adapters translate Claude Code/Codex/other runtime events into canonical client-facing resource facts.

AHP does **not** guarantee loss-free raw PTY history or a complete VT terminal checkpoint. Its TerminalState holds bounded output parts, and its terminal/input is explicitly a server-side effect (no optimistic echo). Its TypeScript AsyncBroadcastQueue and Rust broadcast-based SDK are bounded: readers that lag may miss envelopes, requiring resubscription and re-snapshot. See:
- [AHP connection lifecycle](https://microsoft.github.io/agent-host-protocol/specification/lifecycle.html)
- [Channels & subscriptions](https://microsoft.github.io/agent-host-protocol/specification/subscriptions.html)
- [AHP Terminal Channel](https://microsoft.github.io/agent-host-protocol/specification/terminal-channel.html)
- [Write-ahead reconciliation](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/reconciliation.md)
- [Rust mirror lag warning](https://github.com/microsoft/agent-host-protocol/blob/main/clients/rust/crates/ahp/src/multi_host_state_mirror.rs)

**Non-goal**: implementing the AHP wire protocol, replacing Nession's per-Unit version negotiation with a single global SemVer, or turning tmux into a VS Code Agent Host.

## 2. Authority / topology

```text
 Web / App / CLI / MCP
      │ UI projection + resource subscriptions
      ▼
 Nession client sync engine
      │   logical messages stay identical across routes
      ├──────── P2P ──────────┐
      └── Server Relay ───────┤
                              ▼
                       Nession Agent Host
                       ├─ ChannelRegistry + actor mailbox
                       ├─ Session/Terminal authority (tmux)
                       ├─ Work/Capability state
                       ├─ Conversation adapter projections
                       ├─ Action cursor + bounded journal
                       └─ Snapshot/checkpoint providers

 Nession Server ── Fleet registry / access / routing
                  (not Terminal state or timeline authority)
```

A session here means a Nession tmux-backed Session, **not** necessarily an AHP conversation session. A Session may expose one terminal and zero or more detected works/conversations. Those are separate resources with stable identifiers.

Existing Web `SessionRuntime` is **the client-side owner of attach and route lifecycle**, not the remote session's authoritative data state. Add a client ChannelStateMirror below product/UI with one-way projection and no React dependency. Do not duplicate its existing attach/route authority.

### Resource taxonomy (proposed)

| Channel / canonical identity | Authority | Snapshot purpose | Typical delivery |
| --- | --- | --- | --- |
| `nession://server/fleet` | Server | Agent list, availability and routing metadata | Low volume |
| `nession://agent/{agentId}/root` | Agent | Session summaries, available capability descriptors | Low volume |
| `nession://agent/{agentId}/session/{sessionId}` | Agent | Lifecycle, title, work catalogue, terminal references | Low volume |
| `nession://agent/{agentId}/terminal/{terminalId}` | Agent | Terminal ownership/lifecycle, checkpoint metadata | High volume: separate stream |
| `nession://agent/{agentId}/work/{workId}` | Agent/provider adapter | Detected foreground work and state | Low/medium volume |
| `nession://agent/{agentId}/conversation/{id}` | Provider adapter on Agent | Canonical transcript summaries / active turns | Medium volume |
| Plugin-specific URI paths | Plugin provider | Typed, bounded plugin state | Capability-advertised |

Names are **illustrative** and require validation against Nession's resource identity and protocol naming gates. Identity MUST include the Host: `(agent_id, resource_uri)` or an equivalently globally unique fully qualified resource ID. AHP itself has a multi-host mirror with the same host/resource distinction.

The Session catalogue must contain **references and lightweight summaries only**. Do not subscribe to every conversation/terminal at application startup.

## 3. Protocol model

Retain the existing `nession-protocol` envelope, `ProtocolId`, `ContractVersion`, `Provider`, `Generation` and `Manifest`. Add Channel synchronization as Protocol Units; use current `<answerer>.<subject>.<operation>` naming for operations and emitter-named notifications.

Candidate Units (names subject to the protocol identity gate):
- `agent.channel.subscribe`: subscribe with target resource, desired view, delivery preference, client identity; returns Snapshot and channel cursor or explicit NotFound/Forbidden.
- `agent.channel.unsubscribe`: terminate a subscription/lease.
- `agent.channel.resume`: resource or session subscription set plus cursor(s); returns Replay/Snapshot/Unavailable, never a falsely successful empty list.
- `agent.channel.dispatch`: client intent for permitted reversible mutations, with `client_id + client_seq`.
- `agent.channel.applied`: a **terminal-only** applied watermark, not conflated with the above dispatch echo.
- `agent.channel.action`: Agent-emitted action notification (subject to wire gate).
- `server.fleet.subscribe` / fleet equivalent for server-owned catalogue.

Do not create `.v1` wire names: contract version is separate, per [protocol.md](protocol.md).

### State action envelope (low-volume)

```ts
interface ChannelAction<A> {
  resource: ResourceUri;
  hostEpoch: string;                 // collision-resistant across Host restarts
  serverSeq: string;                 // exact integer encoding: no JS number rounding
  action: A;
  origin?: { clientId: string; clientSeq: string };
  rejection?: { code: string; message?: string };
}
interface ChannelSnapshot<S> {
  resource: ResourceUri;
  hostEpoch: string;
  throughSeq: string;                // exact cut of this state timeline
  state: S;
  completeness: 'complete' | 'partial';
}
```

`serverSeq` is assigned by the **authoritative Host**, not Relay. Use decimal-string IDs (or compatible safe-integer encoding); current terminal `u64` values have JS-safe-number constraints. A distinct Host epoch invalidates old cursors after a restart unless durable sequence continuity is proved.

AHP has one host-wide server sequence. For Nession v1, choose **one Host order for low-volume state actions** and retain **per-Terminal output/resize order** for heavy streaming. Do not claim cross-host total ordering. The high-volume stream uses `streamEpoch + streamSeq`, already modeled in `session_terminal.rs`. A global Host state clock may skip sequence values on any one subscribed channel; the consumer must filter by resource and detect gaps using the Host journal's *overall* watermark or separate per-channel ordering metadata, not treat every missing global number as a same-channel event.

Reducers for each state channel are pure `reduce(state, action): state`, side effects executed *after* accepted authoritative commits. Unknown state-changing action types in an incompatible negotiated schema must not be silently treated as successful convergence. The manifest/capabilities announce available channel schemas and compatibility.

## 4. Subscribe / reconnect barrier

Subscribe is a **transaction against a channel actor/mailbox**, not a free-standing `read_snapshot(); subscribe()` pair:

1. Authorize the resource, register the subscriber at an exact cursor and reserve bounded delivery capacity.
2. Cut a point-in-time snapshot `S` at `throughSeq=N` inside the same serialization domain as commits.
3. Buffer new actions `N+1..` while snapshot transfer is pending.
4. Deliver S, then all subsequent actions in sequence; if buffering exceeds safe bounds, fail/restart with a new snapshot (never continue from an incomplete snapshot).
5. Client applies S first, then buffered actions; status is `syncing` until S and the pending queue are applied.

A reconnect request contains resource cursors and old Host epochs. Outcome is one of:
- **Replay**: every required post-cursor state action is available.
- **Snapshot**: atomic new state baseline plus post-cut actions.
- **Unavailable**: gone, unauthorized, unsupported, or checkpoint cannot be generated.

For ephemeral event-only channels without a reconstitutable snapshot, report a permanent gap explicitly. A disconnect is **not** proof that events were applied: client tracks received vs reducer-applied progress.

The protocol-level AHP `lastSeenServerSeq` is a receipt cursor; Nession needs a separate per-consumer **applied** progress and instance-generation rule for xterm and other asynchronous projections.

### Reconciliation (supported mutable state only)

```text
confirmed = authoritativeSnapshot
pending = locally dispatched reversible actions
rendered = fold(reducer, confirmed, pending)

Host action:
  if own echo: remove matching pending(clientId,clientSeq)
  if rejected: remove pending and show rejection
  apply accepted authoritative action to confirmed
  recompute rendered = fold(reducer, confirmed, remainingPending)
```

Optimistic candidates: title, selected optional work settings, read state, reversible layout metadata. **Not** PTY input, command execution, kill session, permissions, tool side effects, or controller takeover without Agent confirmation. Host must reject stale generation/concurrency violations.

For non-idempotent commands, add a retained deduplication record keyed by client/command identity when feasible, with explicit `applied | rejected | indeterminate` on reconnect. Exactly-once PTY input after an Agent crash is **not guaranteed** merely by ACKs (PTY side effect and durable ACK aren't atomic).

## 5. Terminal as specialized channel

Current components:
- Agent `crates/nession-agent/src/server/session_terminal.rs` owns a session stream epoch/seq and bounded replay ring.
- Web `web/src/platform/terminal-runtime/streamReconciler.ts` orders frames, merges live and resume, but its frontier represents delivery to the output sink, **not asynchronous xterm parser completion**.
- Browser `TerminalController` calls `terminal.write(data, callback)` but does not use a universal parser-applied cursor.
- `SessionRuntime` owns attach/route state.
- Server Relay currently has weaker output-resume behavior than P2P.
- tmux capture provides useful history but not necessarily every VT mode or a perfect alternate-screen checkpoint.

### Terminal protocol state machine

```text
Disconnected
   ↓ subscribe/resume
WaitingCheckpoint ──── unavailable → ExplicitGap
   ↓ checkpoint received
ApplyingCheckpoint
   ↓ xterm write callback
CatchingUp ──── gap expired → WaitingCheckpoint
   ↓ contiguous applied
Live
   ↓ route drop
Disconnected (preserve applied cursor only with same live xterm instance)
```

State counters are separate:
`receivedSeq >= appliedSeq >= ackedSeq`, inside the same `streamEpoch` and client terminal-instance generation. The writer is serial; terminal output, resize, reset and checkpoint barriers must not bypass it. Never ACK before the xterm write callback. If the xterm instance is destroyed, discard its applied proof; obtain and apply a fresh checkpoint.

### Terminal checkpoint (proposed)

```ts
interface TerminalCheckpoint {
  resource: ResourceUri;
  streamEpoch: string;
  throughStreamSeq: string;
  cols: number;
  rows: number;
  representation: 'vt-serialized' | 'tmux-pane-capture';
  fidelity: 'full-vt' | 'screen-only' | 'partial';
  truncatedBefore?: string;
  bytes: Uint8Array;
}
```

A checkpoint must be produced at a verifiable linearization point relative to Agent stream events. **Do not** attach an arbitrary `throughSeq` to a separately executed `tmux capture-pane` and claim exact boundaries: there may be duplicates or a missing interval under concurrent output. Control-mode barrier or an Agent-owned terminal emulator/mirror are candidate implementations. Screen-only snapshots cannot claim a full TUI restoration guarantee. Further work can evaluate `@xterm/headless` + serializer against tmux-native mode extraction; keep the v1 interface independent of that choice.

### Backpressure and slow subscribers

- Agent authoritative stream retention is bounded by **bytes, events and time**; per-subscriber send queues are bounded by bytes.
- A slow client consumes its own backlog. If unable to catch up, it is explicitly marked lagged and required to resume or resnapshot; other observers keep working.
- The browser ACK watermark is advanced after parser completion; apply an adaptive high/low water flow-control window **per client**, not an unconditional global PTY pause.
- Replayed output and live events enter **one ordered reconciler** on either P2P or Relay.
- Retained browser scrollback, tmux history and Agent event journal are different guarantees. An accurate current screen checkpoint does not imply all past output is retained.

This is deliberately stronger than AHP's baseline TerminalState, whose content parts are retained/truncated implementation-defined VT output, and `terminal/input` is a no-op reducer.

## 6. Ownership / security / other channels

AHP TerminalClaim tracks resource ownership. Nession's existing **ControlLease + generation** tracks *which connected user can send input and resize*. They are distinct and should remain distinct:
- Resource owner may be Session/work or user/client.
- Active Controller may be one authorized client, while many Observers subscribe.
- Agent checks ControlLease and generation **at mutation time**, on both P2P and Relay.
- `client_id` is a correlation key, **not authorization**.
- ACL check at subscribe, action dispatch, reconnect and route switch, with resource membership, user identity and entitlement scoped to Host.

Conversation work follows [ai-conversation.md](ai-conversation.md): provider adapters publish normalized, presentation-agnostic facts. Nession owns renderers. Plugin channels declare schema/capabilities, owner and visibility, with no plugin-specific imports in the shared synchronization kernel.

Secret-bearing terminal outputs should not become unbounded durable history by default. Persisted content requires explicit retention, encryption/access, redaction/deletion policy and observability. Avoid persisting PTY input by default.

## 7. Migration strategy

| Phase | Change | Files / owners | Gate |
| --- | --- | --- | --- |
| 0 Architecture | Freeze contracts, channel resource identity, cursor and snapshot invariants | `docs/architecture/`, `crates/nession-protocol/` | RFC/contract acceptance |
| 1 Pilot | Channel actor/registry + subscribe/reconnect + pure reducer sync for Agent session/work presence | Agent state provider, Web React-free state mirror; Server transparent routing | 2 clients, reconnect, atomic subscribe race |
| 2 Terminal | Wire terminal stream through channel; unify P2P/Relay; applied callback ACK; checkpoint fidelity, gap states and bounded queues | Agent terminal service, Web streamReconciler/TerminalController/SessionRuntime, Relay | 100k+ ANSI events, resize, route swaps, slow xterm |
| 3 Plugins & AI | Capability/work/conversation channel adapters and lazy loading | Extensions/capabilities, AI conversation runtime | Cross-provider UI equivalence |
| 4 Durable recovery | Optional journal/checkpoint persistence and replay/history UX | Agent storage, retention/privacy | Agent restart, historical reads, deletion |

Keep prior Protocol Units functional and use capabilities/feature flags to migrate one surface at a time. Do not couple the first slice to an all-at-once Terminal rewrite.

## 8. Required tests / observability

**Deterministic contract/property tests**
- Atomic subscribe while concurrent writer publishes; Snapshot(N) + Actions(N+1..) never duplicates/skips.
- Duplicate, reordered, missing or expired actions; epoch restart; mismatched channel permissions.
- Optimistic two-client interleaving and rejection; Rust/TS reducer parity.
- Multi-host ID collision; same URI on two agents cannot mix projections.

**Terminal fault injection**
- xterm parser deliberately blocked while incoming frames accumulate; applied cursor remains behind received.
- Disconnect mid-checkpoint/mid-batch; xterm instance retained vs destroyed.
- P2P ↔ Relay ↔ P2P switch; no event re-ownership or cursor jump.
- 100k+ numbered output frames, ANSI wrapping and resize, alt-screen/Codex/Claude Code fixtures.
- Slow observer overflow, ring expiry, capture unavailable, Agent restart.
- Session ControlLease transfer during input/resize; stale generation must fail.

**Metrics**
`channel_subscribers`, `channel_replay_gap_total`, `channel_snapshot_duration`, `channel_resync_total{reason}`, `subscriber_queue_bytes`, `terminal_received_minus_applied`, `terminal_ack_latency`, `terminal_checkpoint_fidelity`. Avoid exposing terminal bytes or commands in metric labels.

## 9. Explicit boundaries / decisions still requiring experiments

1. **Checkpoint provider**: tmux control-mode barrier + screen-only v1 versus Agent headless VT mirror; determine with TUI mode/replay fixtures. Do not advertise `full-vt` before demonstrated.
2. **Durability**: initial in-memory state/short replay only; disk journal for a later separately approved phase.
3. **Global vs per-channel sequence**: the low-volume Host action timeline and high-volume Terminal timeline intentionally have different cursors; verify snapshot semantics and version transitions in contract tests before committing names.
4. **Browser renderer policy**: retaining vs reconstructing a terminal instance has different applied-cursor guarantees.
5. **Long-lived clients**: SDK-style bounded broadcast queues are unsafe without overflow detection + resubscription; no silent fast-forward.

Related: [#1094](https://github.com/BestNathan/nession/issues/1094), [#1095](https://github.com/BestNathan/nession/issues/1095), [#1307](https://github.com/BestNathan/nession/issues/1307), [#1309](https://github.com/BestNathan/nession/issues/1309), [#1363](https://github.com/BestNathan/nession/issues/1363), [#1491](https://github.com/BestNathan/nession/issues/1491).
