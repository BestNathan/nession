# Terminal Buffer Consistency & Recovery — RFC v2

> Parent Requirement: [#1645](https://github.com/BestNathan/nession/issues/1645) · [Design Requirement #1927](https://github.com/BestNathan/nession/issues/1927) · Canonical [RFC v2 PR #1922](https://github.com/BestNathan/nession/pull/1922) **supersedes closed Draft PR #1646** · Architecture review: 2026-10-18.
>
> **Scope:** Terminal only. This document decides stream consistency, parser-applied acknowledgement, checkpoint recovery, slow-client isolation and P2P/Relay parity. It does not ship the runtime implementation.
>
> **Related:** [#1648 P0 completed](https://github.com/BestNathan/nession/issues/1648), [#1094 stream/replay](stream-replay.md), [#1095 multi-client](multi-client-ownership.md), [#1096 interaction](interaction-semantics.md), [#1309 lifecycle](session-runtime-ownership.md), [Protocol Unit governance](../../architecture/protocol.md).

## 1. Product contract and limits

The user can keep working through detach/reconnect, browser/mobile foreground transitions, P2P/Relay changes and multiple terminal observers. A successful network attach is **not** evidence of a synchronized terminal buffer. The product must not silently hide missing output or claim a completely reconstructed TUI when its state is unknowable.

Three independent correctness properties are required:

| Property | Owner | What it proves | What it does NOT prove |
| --- | --- | --- | --- |
| **Stream continuity** | Agent Session Stream Owner | Ordered output/authoritative resize events from one epoch and one contiguous sequence | Correct VT screen after a gap |
| **Parser applied** | Current xterm instance + serialized writer | All events through appliedSeq were parsed by this renderer | Browser paint completed, or all modes matched a lost renderer |
| **Screen fidelity** | Actual tmux/PTY state and capture mechanism | A supported representation of screen/history/modes | A complete VT serialization unless independently proven |

**Terminal authorities:** tmux/PTY is the source of actual screen/mode state; Agent owns stream sequencing, replay and control lease, **not** a complete VT emulator. SessionRuntime owns attach/recovery/route state; ConnectionManager adapts I/O; TerminalController owns xterm and publishes parser facts. React is not another owner (see #1309).

Guarantee levels:

- **Continuously applied:** same xterm instance, contiguous replay within retention, no lost VT state. This is the strongest v1 recovery path.
- **Reconstructed screen:** an independently proved checkpoint cut, then contiguous events; fidelity reports screen-only or full-vt truthfully.
- **Degraded live:** a gap or unverified capture makes full reconstruction unavailable. The user may still see new output, but recovery status stays degraded and no cursor falsely attests to missing history.
- **Unavailable:** neither usable replay nor a trustworthy checkpoint exists. This must be observable; reattach cannot silently report synchronized.

Retained memory is bounded. No unbounded historical guarantee, implicit durable log, generic AHP framework, replacement of tmux, input persistence, plugin/Chat/Git/Files/Capsule changes, or exact-once PTY input across Agent crashes.

## 2. Target architecture and ownership

~~~text
       tmux / PTY = pane + VT state authority
                        |
                 single ingress
                        v
 Agent SessionTerminalStreamOwner = timeline authority
     +-- epoch + seq: output, authoritative resize, reset
     +-- retained contiguous log (bytes / events / age)
     +-- checkpoint provider (separate cut + fidelity proofs)
     +-- subscription-specific queue, ACK/credit, generation
                /                    \
          P2P transport         Server Relay transport
                \                    /
                 shared event identity
                        |
            StreamReconciler (ordered received frontier)
                        |
            SerializedXtermWriter (one FIFO per renderer)
                        |
           xterm write callback = parser-applied frontier
                        |
             applied ACK (subscription-scoped)
~~~

- Same session, same Agent stream epoch and seq, independent of physical WebSocket and route; Relay does not resequence or manufacture output.
- Output and **authoritative** pane resize share the timeline. Observer viewport size is local; authoritative resize remains ControlLease-gated. A recorded resize must not be overtaken by an unsequenced authoritative resize.
- One slow observer must not stall the PTY or a healthy observer.
- Stream identity is independent of SessionRuntime route generation; renderer instance generation is independent of stream epoch and client subscription identity.

## 3. Normative state and cursor contracts

Each subscriber/renderer tracks a tuple:

~~~text
StreamID         = (agentInstance, sessionID, streamEpoch)
SubscriptionID   = (clientID, subscriptionGeneration)
RendererID       = (xtermInstanceID, writerGeneration)

receivedSeq      = largest *contiguous* stream seq accepted by the ordering queue
appliedSeq       = largest *contiguous* seq whose effect has finished at xterm
ackSentSeq       = largest applied seq submitted as an ACK
agentAckedSeq    = largest ACK accepted for this subscription (server-side)
~~~

**For a single StreamID + RendererID:** 0 <= ackSentSeq <= appliedSeq <= receivedSeq. A transport that received out-of-order frame 120 with a hole at 119 does not advance receivedSeq to 120. The existing StreamReconciler frontier currently means **delivered-to-sink**, not parser-applied; rename/split that meaning before using it for ACK. A bootstrap cursor received from attach is an assertion about Agent output position, never by itself an applied cursor.

The writer serializes **all** operations that change the displayed terminal: checkpoint reset/clear + snapshot write, output write, authoritative resize, mode-affecting reset. It must not let resize overtake an unfinished output parse. For non-output operations with no xterm write callback, completion is the synchronous operation executed at the correct FIFO position; never manufacture an output ACK merely from socket receipt. For a data frame, only the current instance's terminal.write(data, callback) completion moves appliedSeq. Parser completion is not browser painting.

When xterm is destroyed, its appliedSeq is invalid. A newly built xterm has a new RendererID and must establish its own checkpoint/replay baseline; no copied ACK from the previous renderer. If route changes **without replacing xterm**, its appliedSeq may be reused only after reconciling the same StreamID and subscription handoff, and rejecting stale old-route callbacks/ACKs. Agent may accept ACK only for the current subscription generation, and can retire old subscription credit independently.

ACK can be batched by byte or time but must be cumulative, monotonic and generation-checked. Never confuse **terminal input applied ACK** (#1307) with **terminal output parser applied ACK** (this RFC).

## 4. Checkpoint correctness: two independent dimensions

A checkpoint carries **both**:

1. **Cut consistency**: atomic (proven stream cut) or unverified. Atomic means the captured representation is as-of exactly (streamEpoch, throughSeq) and all subsequent stream effects start at throughSeq+1; every earlier effect is covered exactly once.
2. **State fidelity**: full-vt, screen-only or partial. This describes how faithfully the representation reconstructs the terminal state; it does not certify the cut.

A truncated capture can be **cut-atomic but partial fidelity**. A visually convincing capture can be **screen-only but unverified cut**. Do not collapse these dimensions into one 'partial' bit. A capture with an unverified cut is **not** a synchronization checkpoint, regardless of its on-screen appearance.

Minimal wire **proposal**, not a frozen protocol schema:

~~~ts
type Checkpoint = {
  streamEpoch: string; // exact decimal u64 in next contract version
  throughSeq?: string; // only when cutConsistency === 'atomic'
  cutConsistency: 'atomic' | 'unverified';
  fidelity: 'full-vt' | 'screen-only' | 'partial';
  representation: 'tmux-pane-capture' | 'vt-serialized';
  truncated: boolean;
  cols: number;
  rows: number;
  bytes: Uint8Array;
  reason?: 'capture-failed' | 'cut-unverified' | 'mode-unsupported';
};

type Resume =
  | { kind: 'replay'; streamEpoch: string; fromSeq: string; throughSeq: string; events: TerminalEvent[] }
  | { kind: 'checkpoint-required'; reason: 'expired' | 'epoch-changed' | 'gap' }
  | { kind: 'unavailable'; reason: string };
~~~

The old contract uses u64/JS number with a safe-epoch generator; only a **new** contract revision may migrate to decimal-string exact integers. Never change existing v1 serialization in place. Use contract version, provider generation, manifest negotiation, generated TypeScript and protocol/codegen gates. Old P2P/Relay clients retain their explicitly documented weaker behavior and cannot claim new synchronization guarantees.

### 4.1 The attach/capture race that must be eliminated

Current main has an already-attached branch in crates/nession-agent/src/server/websocket.rs: the peer is registered with output_tx absent while capture_for_bootstrap awaits a separate tmux process, and only receives live output after the capture is sent. Concurrent producer bytes can therefore land in capture, stream, both or neither **from the subscriber's perspective**. Sending capture first on the wire does not prove a capture-to-stream cut. Setting throughSeq to the current Agent cursor after capture cannot fix this.

The implementation must prove one of the following, with deterministic fault injection:

- A **single, serialized producer/capture ingress** that establishes a linearization point in the same ordering domain as output and authoritative resize; or
- An equivalent **bounded cut + reconciliation protocol** whose proof includes tmux capture ordering and exact correspondence to Agent output sequences. If tmux cannot expose the boundary, this alternative is not available.

Required proof sequence:

~~~text
producer emits seq 100
checkpoint cut is established at seq 100 (not guessed after async capture)
events 101+ are retained/queued throughout capture + subscription registration
client receives snapshot@100, finishes current xterm parse
client applies contiguous events 101, 102, ... with no double-apply
~~~

Holding/subscribing first prevents loss but does **not** by itself prove that captured screen excludes post-cut events. Capturing first then subscribing does not prevent loss. If either guarantee cannot be proven with the actual tmux backend, mark cutConsistency=unverified, keep the session in needs-resync/degraded-live, and do not emit throughSeq as a trusted cut. Do **not** ship a nominal atomic checkpoint as a workaround.

Do not assume tmux capture-pane preserves alternate screen, active mouse mode, application cursor mode, bracketed paste or full VT internals. The first implementation may aim for screen-only with deterministic redraw if **cut atomicity** is independently proven. Introducing a headless VT emulator is a separate, evidence-driven follow-up, not a prerequisite.

## 5. Replay, gap, reset, and degraded live

Replay is valid only when all events from (requestedAppliedSeq+1) through an explicitly returned, bounded head are complete and ordered within the **same epoch**. If not, return checkpoint-required or unavailable, never a shorter tail labelled replay. A checkpoint with unverified cut does not turn that result into synchronized.

For healthy preserved xterm: resume from appliedSeq, not the StreamReconciler's sink-delivery frontier. Duplicates at/below appliedSeq may be discarded; frames not parsed before disconnect must be safely replayed. A killed/recreated xterm cannot reuse the old applied cursor even if Agent epoch is unchanged.

If the ring expires, Agent restarts, reconnect crosses epochs, parser queue overflows, or route switch cannot prove continuity:

~~~text
LIVE -> GAP_DETECTED -> NEEDS_RESYNC
       -> REPLAY_COMPLETE -> CATCHING_UP -> SYNCHRONIZED
       -> CHECKPOINT_ATOMIC -> APPLY_CHECKPOINT -> CATCHING_UP -> SYNCHRONIZED*
       -> CHECKPOINT_UNVERIFIED / UNAVAILABLE -> DEGRADED_LIVE
~~~

(*) Synchronized refers to the **declared fidelity**. It is wrong to label a screen-only reconstruction full-vt.

UI may display new output after gap to avoid freezing but must keep explicit degraded status and an invalidated continuity proof. Existing StreamReconciler skipHole/abandon can be retained as a **display-only degraded path**, never as proof that the skipped events have been applied. SessionRuntime alone governs the recovery state. Recovery flags cannot be cleared by attach success or stale parser callbacks (P0 #1648).

## 6. Bounded slow-consumer isolation

Maintain **separate** budgets and metrics:

| Queue/window | Owner | Required bounds |
| --- | --- | --- |
| Replay retention | Agent stream owner | bytes + event count + age (all explicit) |
| Per-subscriber outbound | Agent subscriber | bytes + frames + stall deadline + ACK credit |
| Reorder and parser-writer backlog | browser client | bytes + frames + wait time |

Existing agent outbound (4 MiB / 64 frames and stall grace) and 4096-event ring are useful baselines but **do not** imply byte-aware replay or parser credit. At/over a limit, isolate the slow subscription, explicitly require resync, and release its memory. Do not globally block PTY producer waiting for one slow browser. A healthy observer must continue.

ACK credit must be based on actual parser-applied bytes in that subscriber's current generation. Credits, retentions and retry intervals are configurable/tested policy values; initial numerical thresholds are not normative until measured with fixtures. Do not silently drop old events or advance trusted appliedSeq across a hole.

## 7. P2P / Relay semantic equivalence

Both paths carry the same Agent-assigned stream epoch, seq, resume response, checkpoint metadata and output applied ACK semantics. Relay forwards identity and capabilities; it must not create a second timeline or bypass ordering for authoritative resizes.

Route switch sequence:

1. SessionRuntime selects new transport, retains current renderer generation if xterm survives.
2. Establish new subscription and negotiate current Terminal contract version/epoch.
3. Resume/replay from the renderer's appliedSeq, buffering/de-duplicating overlap with any still-live old path.
4. Switch active delivery once continuity can be proven; retire old subscription and ignore late frames/ACKs from old binding.
5. Otherwise transition to needs-resync/degraded-live; never assume P2P cursor makes an unsequenced Relay stream safe.

Controller/Observer ControlLease is unchanged: observer may subscribe and ACK output but not write PTY input or authoritative resize. Input sequence and output ACK must remain disjoint.

## 8. Runtime ownership and user-facing states

- **SessionRuntime:** owns attached/reconnecting, current route, continuity health, needs-resync, downgrade reason and renderer binding generation; publishes immutable read-only projections.
- **StreamReconciler:** transport-agnostic ordering, duplicate suppression, gap detection; exposes **received** contiguous frontier and never makes UI recovery verdicts.
- **SerializedXtermWriter / TerminalController:** handles view operations and parser callbacks, reports applied progress/fidelity; does not decide reconnect route.
- **ConnectionManager:** I/O adapters only; no duplicated state machine, no direct Relay bypass around ordered stream.
- **Agent stream owner:** events/replay/checkpoint proofs/credit accounting, independent of client lifetime.

Default UX stays quiet (VISION.md / PRINCIPLE.md). Show status only if recovery is incomplete or degraded, with small contextual indication plus accessible detail explaining screen-only, missing history or retry. Do not add persistent status panels to Capsule or rework unrelated UI.

## 9. Staged implementation and exact-SHA acceptance

**P0: completed** in #1648 / PR #1647: do not clear history gap on attach; only current, non-truncated bootstrap parser callback can mark that P0 repair done; Relay disconnect conservatively requests bootstrap. This did NOT solve the atomic checkpoint cut.

**Implementation issue tracking:** [P1 #1924](https://github.com/BestNathan/nession/issues/1924) (renderer/writer/ACK), [P2 #1925](https://github.com/BestNathan/nession/issues/1925) (Agent checkpoint/replay/subscriber credit), [P3 #1926](https://github.com/BestNathan/nession/issues/1926) (Relay parity/E2E). The first independently shippable P1-A slice is [#1931](https://github.com/BestNathan/nession/issues/1931). The parent [#1645](https://github.com/BestNathan/nession/issues/1645) remains open for runtime evidence.

**P1: renderer correctness**

- Add FIFO SerializedXtermWriter, separating ordered received cursor from parser-applied and acknowledged cursor.
- Queue checkpoint/reset, output and authoritative resize; guard old callback/generation; bound reorder/parser queues.
- Unit/integration tests for delayed parser, callback reorder, remount, disposal, epoch switch, partial bootstrap and unchanged ControlLease/input.
- Applied ACK on wire may ship with the matching Agent/Protocol slice; the renderer core must be tested without a network.

**P2: Agent checkpoint/replay**

- Prove actual tmux stream/checkpoint linearization or explicitly fall back to unverified/degraded (never falsely synchronize).
- Bound replay by bytes/events/age, isolate subscriber credit and expose complete replay / checkpoint-required / unavailable.
- No fabricated throughSeq; include Agent restart, already-attached capture and concurrent output/resize fixtures.

**P3: transport parity + E2E**

- Relay and P2P share event identity, resume, checkpoint and ACK; route-switch handshake preserves or rejects continuity.
- Deterministic E2E must cover numbered 100k+ output and ANSI bursts, slow parser, two clients with one stalled, xterm replacement, P2P→Relay→P2P, already-attached concurrent snapshot, resize interleavings, retained/missing history, capture failure and agent restart.
- TUI fixtures must exercise alt-screen enter/exit, cursor/app modes, bracketed paste, mouse, resize and redraw. Real Claude/Codex/htop can supplement, not replace deterministic fixtures.
- Show exactly which guarantee was proven (stream/parser/full-vt or screen-only); require source-aligned CI/Acceptance/E2E evidence per issue and exact PR head, plus post-merge checks when applicable.

### Acceptance mapping to #1645

| Parent SC | Required proof |
| --- | --- |
| SC-01/02 | Agent timeline owner shared by P2P/Relay; output and authoritative resize have one ordering policy; multi-client noninterference |
| SC-03/06 | No applied/ACK before parser callback; callback/ACK tied to stream, subscription and renderer generations |
| SC-04/08 | Atomic checkpoint cut independently proved; fidelity and truncated/failure statuses reported separately |
| SC-05 | Complete replay OR explicit checkpoint-required/unavailable; degraded display never masquerades as synchronized |
| SC-07 | Agent retention, subscriber and browser queues independently bounded; healthy observer unaffected |
| SC-09 | Preserve existing passing input ACK/ControlLease evidence; do not expand scope |
| SC-10/11 | Deterministic real TUI/fault injection, version/manifest/codegen compatibility, exact-SHA acceptance |

**Ship gate:** design-only PR can be reviewed and merged as design documentation; it does not mark #1645 implementation SCs Pass. Runtime P1/P2/P3 need separate issues and verified checks.

## 10. External references and non-goals

- [Microsoft AHP Terminal Channel](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/terminal-channel.md) is a reference for resource/subscribe/reconciliation semantics, not a drop-in VT checkpoint or global Channel Registry requirement.
- [VS Code terminal service](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts) and [terminal instance](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts) motivate parser-applied acknowledgement and bounded PTY flow control.
- This RFC does **not** change #1307 PTY input exactly-once limitations, #1309 SessionRuntime ownership or core protocol unit versioning. Durable Terminal history and independent read-only historical playback remain separately optional under #1094.
