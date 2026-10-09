import type { ConnectionOptions } from './types';
// The producer's own type rather than a restatement of its shape. An inline
// structural type is how a field-name divergence type-checked vacuously here
// once already (#1307 stage 3): it accepted `inputAppliedThrough` where the
// reader wanted `appliedThrough`, the assignment compiled, and the reconcile
// silently did nothing. Naming the producer makes the next such spelling a
// compile error.
import type { TerminalInputAck } from '@/product/terminal';
import type { TerminalTransport, TerminalInputSeed } from './transport/TerminalTransport';
import { StreamReconciler, type ResumeReply } from './streamReconciler';
import type { TerminalBootstrap } from './bootstrap';
import { PendingInputQueue, type InputDrop, type InputQueueBounds } from './inputQueue';

/**
 * How much typed-ahead input this client will hold for a session (#1307).
 *
 * The requirement asks for these to be fixed by measurement of real typing and
 * paste, and that measurement has now been taken. What it measured:
 *
 * * **A keystroke is one chunk of one byte.** Real `keydown` events dispatched
 *   at xterm's own helper textarea produced exactly one `onData` each.
 * * **A paste is one chunk carrying all of it.** A 200-line block arrived as
 *   one chunk of 5 289 bytes and a 50 000-character single line as one chunk of
 *   50 000 — xterm split neither.
 * * **The fastest a key can repeat is 30 chunks a second.** macOS
 *   `KeyRepeat=2` is 2/60 s ≈ 33 ms; `InitialKeyRepeat=15` is 250 ms before the
 *   first repeat. That is the floor on how fast a queue can be filled.
 * * **A realistic paste is 50 KB to 500 KB.** This repository's own corpus:
 *   a 200-line source block is ~5 KB, the largest source file is 326 KB, and
 *   the largest text file is 516 KB.
 *
 * Against those, per bound:
 *
 * * **128 chunks, confirmed.** The age bound discards the whole queue once its
 *   oldest chunk is 5 s old, and `accept` expires before it bounds, so at the
 *   measured 30 chunks/s the queue can never hold more than **150** chunks
 *   before age takes it anyway. 128 sits just under that ceiling rather than
 *   beside it: at maximum key repeat the chunk bound refuses ~0.73 s before the
 *   TTL would have discarded the same input, and at a human 10 keys/s neither
 *   bound is reached inside the TTL (50 chunks).
 * * **1 MiB, moved up from 64 KiB.** The measured paste says 64 KiB was sized
 *   for the wrong thing. It is *dead* for typing — 128 one-byte chunks cannot
 *   approach 64 KiB — so the only chunk that can reach it is a paste, and a
 *   chunk is refused whole: a user who pasted while one keystroke was pending
 *   lost the entire paste. Measured pastes run to 500 KB, so the bound is set
 *   to admit one with better than 2× headroom. It is still far below the
 *   smallest wire bound on the path (the agent's 4 MiB outbound byte budget,
 *   which `charge` clamps to rather than rejecting), so the queue stays the
 *   binding constraint.
 * * **5 s, confirmed.** A product judgement rather than a measurement — the
 *   only thing the numbers fix is that it must not fall under what 128 chunks
 *   can cover, and 30 chunks/s × 5 s = 150 clears it. What it is chosen for is
 *   the failure the requirement names: bytes typed during an outage arriving at
 *   the shell much later, as if the user had just typed them, possibly into a
 *   different application state than the one they were typed for.
 *
 * Exported so a test can state "past the byte bound" against the policy itself
 * rather than restating a number that would drift from this one silently.
 */
export const INPUT_QUEUE_BOUNDS: InputQueueBounds = {
  maxChunks: 128,
  maxBytes: 1024 * 1024,
  maxAgeMs: 5_000,
};

/**
 * Deadline for the periodic keepalive ping.
 *
 * Nothing is decided on the outcome, so this only bounds how long a pending
 * keepalive may sit in the request layer before it is cleaned up — it is not a
 * liveness deadline. The probe that *does* decide is
 * `SessionRuntime`'s, and it carries its own, shorter one (#1233).
 */
const KEEPALIVE_PING_TIMEOUT_MS = 10_000;

export class ConnectionManager implements TerminalTransport {
  readonly mode: 'p2p' | 'relay';
  private sessionName: string;
  private agentApi?: ConnectionOptions['agentApi'];
  private serverConnection?: ConnectionOptions['serverConnection'];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private relayUnsubOutput: (() => void) | null = null;
  private relayUnsubResize: (() => void) | null = null;
  private relayUnsubInputAck: (() => void) | null = null;
  private p2pUnsubOutput: (() => void) | null = null;
  private p2pUnsubResize: (() => void) | null = null;
  private p2pUnsubError: (() => void) | null = null;
  private p2pUnsubInputAck: (() => void) | null = null;
  private p2pUnsubControlChanged: (() => void) | null = null;
  private disposed = false;
  /**
   * Input the PTY has not confirmed (#1307).
   *
   * It replaces a plain `string[]` FIFO and is bounded, sequenced and
   * identity-bound — see {@link PendingInputQueue}, which owns every one of
   * those decisions. This class only decides *when* to hand it over.
   *
   * **One queue per transport generation, by construction.** A transport swap
   * rebuilds this manager (`transportEpoch` in the orchestration), so anything
   * still pending is discarded with the manager that numbered it — which is the
   * conservative answer and the one the requirement's "bound to runtime/
   * transport generation" clause asks for: a different transport may be a
   * different agent on a different cursor, and bytes numbered against the old
   * one mean nothing to it.
   */
  private pendingInput = new PendingInputQueue(INPUT_QUEUE_BOUNDS);
  /**
   * Resize pending while state !== 'attached'. Coalesced — only the latest
   * {cols, rows} survives; intermediate sizes during the connect/reconnect
   * window are dropped. Flushed (as a single terminal.resize) by
   * flushAllOutbound once the agent acks client.attach.
   */
  private pendingResize: { cols: number; rows: number } | null = null;
  /**
   * The size the session last heard from this client (#1503 follow-up).
   *
   * A repeat of it is a round trip that cannot change anything: the agent's own
   * guard makes a resize to the size the window already has a no-op (#1490), so
   * what the client saves by not sending it is traffic and a `%output`-visible
   * wake-up, not correctness. The ResizeObserver produces these readily — a
   * container that moves and comes back, a debounced fire that lands on the size
   * already sent, and, on every attach, the coalesced size that the attach
   * itself already stated.
   *
   * **What this must not become is a claim that a repeat is meaningless in
   * general.** The window is shared (`window-size manual`, last writer wins), so
   * another client may have moved it since — and only the agent sees every
   * `resize-window`, including the ones it did not get from us. So the dedup
   * covers exactly what this client knows: sizes it put on the wire itself, and
   * the one the attach stated (which is where {@link noteAttachedSize} seeds
   * it). Anything else is the agent's call, and it already makes it.
   */
  private lastSentResize: { cols: number; rows: number } | null = null;
  /**
   * Owns the stream cursor and the order frames are applied in (#1303). This
   * class moves bytes and never decides what is next in the timeline: a live
   * frame and a replay answer are handed to the same reconciler, which is the
   * only writer of the cursor.
   */
  private readonly reconciler: StreamReconciler;
  private isAttached: () => boolean;
  /** Notified after input is handed to either transport — see `onInputSent`. */
  private onInputSent: () => void;
  /**
   * Notified when the stream leaves the consumer's buffer with a hole no later
   * replay can fill — see `ConnectionOptions.onStreamTruncated` (#1304).
   */
  private onStreamTruncated: () => void;
  /**
   * Notified when input is lost rather than delivered — see
   * `ConnectionOptions.onInputDrop` (#1307 SC-09).
   */
  private onInputDrop: (drop: InputDrop) => void;

  /**
   * Bytes from the agent. `bootstrap` marks the session's history rather than
   * its live output, and carries what the agent said about the snapshot
   * (#321/#1305) — see {@link TerminalTransport.onOutput}. Both paths deliver
   * it: P2P from the frame the agent API decoded, relay from the payload the
   * Server forwarded verbatim.
   */
  onOutput: ((data: Uint8Array, bootstrap?: TerminalBootstrap) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.mode = options.mode;
    this.sessionName = options.sessionName;
    this.agentApi = options.agentApi;
    this.serverConnection = options.serverConnection;
    this.isAttached = options.isAttached ?? (() => false);
    this.onInputSent = options.onInputSent ?? (() => {});
    this.onStreamTruncated = options.onStreamTruncated ?? (() => {});
    this.onInputDrop = options.onInputDrop ?? (() => {});
    // The queue owns *what* is lost; this is the wire from its record to the
    // layer that decides what the user is told (#1307 SC-09). Set here rather
    // than passed in, because the queue is built here and nothing above it
    // should have to know the queue exists to hear about a loss.
    this.pendingInput.onDrop = (drop) => this.onInputDrop(drop);
    this.reconciler = new StreamReconciler(
      (epoch, afterSeq) => this.resumeStream(epoch, afterSeq),
      {
        onOutput: (data, bootstrap) => this.onOutput?.(data, bootstrap),
        onResize: (cols, rows) => this.onResize?.(cols, rows),
        // Only the reconciler can tell a buffer that is whole from one with a
        // stretch given up on, and only this class holds the session's owner.
        // It carries the fact up; what repair that implies is not the
        // transport's decision (#1304).
        onStreamTruncated: () => this.onStreamTruncated(),
      },
    );

    if (this.mode === 'p2p' && this.agentApi) {
      this.setupP2P();
    } else if (this.mode === 'relay' && this.serverConnection) {
      this.setupRelay();
    }
  }

  /**
   * Take one chunk of user input.
   *
   * Accepted first, sent second, and the order is the contract: a chunk that
   * reaches the transport has already been numbered, so the acknowledgement
   * that eventually comes back can be matched against something. Input refused
   * at a bound never reaches the transport and is recorded on the queue
   * instead — the requirement's answer to undeliverable input is a stated
   * loss, not a silent one.
   */
  send(data: string): void {
    if (this.disposed) { return; }
    // A client without the lease does not get to number input at all (#1307
    // SC-10). The capability refuses an observer's `sendInput` as well, but it
    // refuses it *after* this point, and a chunk accepted here is not inert
    // until then: it holds a position, and the positions above the cursor are a
    // contiguous run the agent reads as a gap the moment one of them is missing
    // or out of order. So an observer's keystroke is not merely late — it is a
    // hole the client's own real input is then numbered across, which the agent
    // refuses for every chunk that follows. Refusing here means the queue never
    // holds bytes this client has no right to send.
    //
    // Asked of the capability rather than mirrored, because the lease has one
    // owner and a second copy of "who holds it" is a second answer that can
    // drift from the first. P2P only, like the rest of the role gate: the relay
    // path binds no agent capability, and `observerReadOnly` in the
    // orchestration is P2P-only for the same reason.
    if (this.agentApi?.getControlState(this.sessionName).role === 'observer') { return; }
    // Refused at a bound: the input never reaches the transport, so there is
    // nothing to hand over and nothing to question the link about. The drop is
    // recorded on the queue for whoever reports it.
    if (!this.pendingInput.accept(data)) { return; }
    // Queued rather than sent: the probe asks whether the link is there, and
    // input that was never offered to the link cannot answer that (#1264).
    if (!this.isAttached()) { return; }
    this.flushInputBuffer();
    // Reported for both transports, and even when a send inside the flush
    // threw: a refused send is exactly the case worth questioning, and the
    // owner decides for itself whether a check is warranted right now (#1264).
    this.onInputSent();
  }

  /**
   * Hand over everything the queue is holding that has not been delivered.
   *
   * Called by the orchestration effect when the session becomes `attached`, and
   * from `send()` on the live path — the two are the same operation: on a live
   * path the queue is normally empty by the time the next keystroke arrives, so
   * this sends exactly the chunk just accepted, and after a reconnect it sends
   * the run that was typed while the transport was away.
   *
   * Reconcile runs **before** this, in the orchestration effect, and that order
   * is load-bearing: a flush that preceded the attach reply would re-send
   * chunks the agent had already applied and, worse, would do it with numbers
   * derived from a stale cursor.
   */
  flushInputBuffer(): void {
    if (this.disposed || this.pendingInput.size === 0) { return; }
    const outbound = this.pendingInput.outbound();
    if (outbound === null) {
      // No epoch yet — an agent built before this contract, or a transport that
      // has not stated a cursor. Send unsequenced and do not retain: there is
      // nothing a later retry could be checked against, and holding the bytes
      // would only delay their discard by the TTL.
      //
      // The relay used to be here by *transport* rather than by not knowing a
      // cursor (#1307 stage 2): its 16 ms merge kept the newest frame's
      // envelope, so a sequence sent through it would have described only the
      // last frame of a burst while carrying all of them. The merge now states
      // the range it covers and refuses to merge a burst that has none
      // (`merged_range`), which is what let the split move from "always" to
      // "only when there is no position to send".
      for (const data of this.pendingInput.drain()) {
        this.sendRawInput(data);
      }
      return;
    }
    // One frame per chunk. A chunk that coalesced several events would carry a
    // range, which the agent understands, but nothing produces one yet: xterm
    // delivers a paste as a single `onData`, so the batching the requirement
    // asks for is already the shape of the event rather than something this
    // layer has to do (#1307 SC-14).
    for (const chunk of outbound) {
      this.sendSequencedInput(chunk.data, chunk.seq);
    }
  }

  /** Send input with no position — a transport or peer that cannot carry one. */
  private sendRawInput(data: string): void {
    if (this.mode === 'p2p' && this.agentApi) {
      // The underlying socket may be mid-reconnect or disposed — the agent
      // transport refuses with a throw ('WebSocket not connected' /
      // 'WebSocketService disposed'). Drop rather than surface a transport
      // race as a user-visible error; the runtime's reconnect budget owns
      // recovery and the isAttached gate covers the transient window.
      try {
        this.agentApi.sendInput(this.sessionName, data);
      } catch { /* transport reconnecting */ }
    } else if (this.mode === 'relay' && this.serverConnection?.isReady()) {
      this.serverConnection.sendRelayInput(this.sessionName, data);
    }
  }

  /**
   * Send input at a position the agent can acknowledge.
   *
   * One chunk is one position: `seqStart === seqEnd`. The range exists in the
   * contract because a frame may cover several chunks, and nothing here
   * produces one yet — see {@link flushInputBuffer}.
   *
   * Both transports carry the position. A relay frame states it the same way a
   * direct one does, and the Server's merge is what keeps it true across a
   * burst: the merged frame states the first frame's `seq_start` through the
   * last frame's `seq_end`, so the position a client sent is the position the
   * agent reads (#1307 SC-05).
   */
  private sendSequencedInput(data: string, seq: number): void {
    const epoch = this.pendingInput.boundTo?.inputEpoch;
    if (epoch === undefined) { return; }
    if (this.mode === 'p2p' && this.agentApi) {
      try {
        this.agentApi.sendInput(this.sessionName, data, {
          inputEpoch: epoch,
          seqStart: seq,
          seqEnd: seq,
        });
      } catch { /* transport reconnecting — the chunk stays pending */ }
    } else if (this.mode === 'relay' && this.serverConnection?.isReady()) {
      this.serverConnection.sendRelayInput(this.sessionName, data, {
        inputEpoch: epoch,
        seqStart: seq,
        seqEnd: seq,
      });
    }
  }

  /**
   * Send a terminal resize to the agent (client → tmux direction).
   *
   * Gated on the runtime's attach phase (the `isAttached` reader it hands the
   * transport) — while the transport is
   * up but client.attach has not yet been acknowledged (state 'connected', or
   * 'reconnecting' during P2P failover), the size is stashed in
   * `pendingResize` (coalesced: only the latest value survives). The stashed
   * size is flushed as a single terminal.resize by flushAllOutbound once the
   * agent acks attach. This avoids the `not_attached` toast the agent would
   * otherwise return for a resize that arrives before its session map has an
   * entry — a race that is trivially triggered on mobile by viewport churn
   * during attach/reconnect (virtual keyboard, input panel, rotation).
   */
  sendResize(cols: number, rows: number): void {
    if (this.disposed) { return; }
    if (!this.isAttached()) {
      this.pendingResize = { cols, rows };
      return;
    }
    this.sendResizeRaw(cols, rows);
  }

  /**
   * Flush any resize buffered before the session was attached.  Coalesced —
   * only the latest value is sent, so a burst of ResizeObserver fires during
   * the connect window collapses to one terminal.resize on the wire.
   */
  flushPendingResize(): void {
    if (this.disposed || this.pendingResize === null) { return; }
    const { cols, rows } = this.pendingResize;
    this.pendingResize = null;
    this.sendResizeRaw(cols, rows);
  }

  /**
   * Flush every outbound buffer (input FIFO, then coalesced resize) in one
   * call.  Wired to the terminalState === 'attached' transition in
   * TerminalWorkspace so queued I/O leaves the browser as soon as the agent
   * has acked client.attach.  Order matters: input first, then resize — the
   * agent expects a live session before accepting terminal.* I/O, and a
   * resize immediately after attach is the correct PTY size update.
   */
  flushAllOutbound(): void {
    this.flushInputBuffer();
    this.flushPendingResize();
  }

  /**
   * Seed the size the session was told at attach, so the coalesced resize that
   * follows the attach is not sent back as a "change" (#1503 follow-up). The
   * attach states a size and the agent applies it; a client that then sends the
   * same pair is describing where it already is.
   */
  noteAttachedSize(cols: number, rows: number): void {
    this.lastSentResize = { cols, rows };
  }

  private sendResizeRaw(cols: number, rows: number): void {
    const last = this.lastSentResize;
    if (last !== null && last.cols === cols && last.rows === rows) {
      return;
    }
    if (this.mode === 'p2p' && this.agentApi) {
      try {
        this.agentApi.sendResize(this.sessionName, cols, rows);
        // Recorded only where the call returned: a throw means nothing left the
        // client, so the next attempt must still send it.
        this.lastSentResize = { cols, rows };
      } catch { /* transport reconnecting — coalesced via the isAttached gate */ }
    } else if (this.mode === 'relay' && this.serverConnection?.isReady()) {
      this.serverConnection.sendRelayResize(this.sessionName, cols, rows);
      this.lastSentResize = { cols, rows };
    }
  }

  /**
   * Apply the agent's cursor, whichever transport carried it (#1307).
   *
   * One method rather than two, because the relay's acknowledgement means
   * exactly what the direct one means and a client that read them differently
   * would retry against a position the agent never stated. The relay does not
   * weaken it: the Server forwards the notification unchanged, and the burst
   * merge that used to make a per-frame id meaningless no longer touches a
   * cursor, which covers every byte of every frame it folds together.
   */
  private applyInputAck(ack: TerminalInputAck): void {
    this.pendingInput.acknowledge(ack.inputEpoch, ack.appliedThrough);
    if (ack.controlGeneration !== undefined) {
      this.noteControlGeneration(ack.controlGeneration);
    }
  }

  /**
   * Note the lease generation, discarding pending input if it moved.
   *
   * Reuses the queue's own reconcile rather than a second "clear if changed"
   * rule, so there is one place that decides what a moved generation means —
   * and it is the place that already knows which chunks were numbered against
   * the old one.
   */
  private noteControlGeneration(generation: number | undefined): void {
    const bound = this.pendingInput.boundTo;
    if (!bound || generation === undefined || bound.controlGeneration === generation) {
      return;
    }
    this.pendingInput.reconcile({ ...bound, controlGeneration: generation });
  }

  dispose(): void {
    this.disposed = true;
    this.reconciler.dispose();
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.p2pUnsubOutput?.();
    this.p2pUnsubResize?.();
    this.p2pUnsubError?.();
    this.p2pUnsubInputAck?.();
    this.p2pUnsubControlChanged?.();
    this.relayUnsubOutput?.();
    this.relayUnsubResize?.();
    this.relayUnsubInputAck?.();
    this.onOutput = null;
    this.onError = null;
    this.onResize = null;
  }

  private setupP2P(): void {
    const api = this.agentApi!;

    this.p2pUnsubOutput = api.onOutput((frame) => {
      if (this.disposed) {
        return;
      }
      // Synchronous on purpose: the reconciler places the frame in the
      // timeline before the next one can arrive, so two frames can never be
      // in flight against the same cursor (#1303).
      this.reconciler.acceptLive(frame);
    });

    this.p2pUnsubResize = api.onResize((frame) => {
      if (this.disposed) {
        return;
      }
      // A resize the agent recorded consumed a sequence number, so it belongs
      // in the timeline and only the reconciler may apply it: applying it here
      // would leave its sequence unaccounted for and hold the next live frame
      // behind a round trip (#1303). A resize with no position — the
      // `%window-resize` echo — never had one to account for, and still goes
      // straight through; it goes through the reconciler to get there because
      // it is also the newest word on the size, and the resizes it overtakes
      // while they wait for their place have to learn that (#1350). The
      // reconciler is the only thing that can tell them: the buffer is its.
      if (frame.streamEpoch !== undefined && frame.streamSeq !== undefined) {
        this.reconciler.acceptLiveResize({
          cols: frame.cols,
          rows: frame.rows,
          streamEpoch: frame.streamEpoch,
          streamSeq: frame.streamSeq,
        });
        return;
      }
      this.reconciler.acceptLevelResize(frame.cols, frame.rows);
    });

    // The agent's applied cursor (#1307). A cursor rather than a receipt for
    // this frame: the relay merges input frames, so on that path the id a
    // reply would be paired by is gone for every frame but the last — which is
    // the whole reason the agent states a position instead of answering each
    // keystroke. `applied_through` covers every chunk at or below it, so a
    // dropped acknowledgement costs nothing: the next one says the same thing.
    this.p2pUnsubInputAck = api.onInputAck((ack) => {
      if (this.disposed) { return; }
      this.applyInputAck(ack);
    });

    // A lease that moved takes this client's pending input with it (#1095,
    // #1307 SC-08): the bytes were typed under a generation that no longer
    // holds the session, and they must not arrive later under the new one's
    // name — which is exactly what would happen if a client that lost the
    // lease and got it back simply flushed what it had been holding.
    this.p2pUnsubControlChanged = api.onControlChanged((sessionName, state) => {
      if (this.disposed || sessionName !== this.sessionName) { return; }
      this.noteControlGeneration(state.generation);
    });

    this.p2pUnsubError = api.onError((err) => {
      if (this.disposed) { return; }
      // Belt-and-suspenders: the outbound gate should make `not_attached`
      // unreachable, but if a race slips through (e.g. a stale message
      // already on the wire before the gate landed) we swallow it here
      // rather than surface a transient timing race as a user-visible
      // toast.  Real agent errors (session actually missing) surface via
      // the client.attach error path instead.
      if (!this.isAttached() && err.notAttached) {
        return;
      }
      this.onError?.(new Error(err.message));
    });

    // Pure transport: ConnectionManager sends/receives messages but never
    // initiates protocol actions.  client.attach timing is owned by the
    // SessionRuntime.
    this.pingTimer = setInterval(() => {
      if (this.disposed) { return; }
      // Fire-and-forget, and deliberately not a verdict: this keeps the
      // *agent's* watchdog fed, which is the direction the wire was built for.
      // The reverse question — is the agent still answering? — belongs to the
      // session runtime's liveness probe, which treats a missed pong as
      // transport loss (#1233). Answering it here would put a recovery
      // decision inside what this class documents itself as: pure transport.
      void api.ping(KEEPALIVE_PING_TIMEOUT_MS).catch(() => {
        /* the runtime's liveness probe owns recovery */
      });
    }, 30_000);
  }

  /** Seed stream cursor after attach (late joiner / reconnect #1094). */
  seedStreamCursor(streamEpoch: number | undefined, streamCursor: number | undefined): void {
    this.reconciler.seed(streamEpoch, streamCursor);
  }

  /**
   * Reconcile the input cursor against what the agent stated on attach
   * (#1307).
   *
   * This is SC-04's mechanism and the reason the attach reply carries these two
   * numbers: a client that has just attached does not know what became of the
   * input it had in flight, and this is where it finds out. The queue keeps
   * everything above the stated cursor — that is the retry — and discards
   * everything if the *epoch* moved, because then nothing in it can be proven
   * applied or proven unapplied, and the alternative to saying so is replaying
   * a command that may already have run.
   *
   * Both transports bind. The relay used to be excluded because its merge
   * destroyed the position a sequence carries; the merge now states the range
   * it covers (#1307 SC-05), so the exclusion would only be a client that
   * cannot retry what it typed.
   */
  seedInputCursor(seed: TerminalInputSeed | undefined): void {
    if (this.disposed || !seed) { return; }
    if (seed.inputEpoch === undefined) { return; }
    this.pendingInput.reconcile(
      {
        sessionName: this.sessionName,
        inputEpoch: seed.inputEpoch,
        controlGeneration: seed.controlGeneration,
      },
      // The cursor is the reconcile: without it the queue would re-send every
      // chunk from the start of the run, and the agent — which refuses a frame
      // that does not continue its cursor — would answer each one with the
      // position the client already had.
      seed.appliedThrough,
    );
  }

  /**
   * Ask the agent for the events after a cursor (#1094), on the reconciler's
   * behalf — it decides when a replay is worth asking for and what to do with
   * the answer.
   *
   * Only P2P has a stream to resume: relay frames carry no sequence numbers, so
   * nothing on that path ever asks. A refusal is a rejection rather than an
   * empty answer, because the reconciler reads "no events after your cursor"
   * as a cursor that is up to date, and a request that never happened must not
   * look like one that did.
   */
  private resumeStream(epoch: number, afterSeq: number): Promise<ResumeReply> {
    const api = this.agentApi;
    if (this.mode !== 'p2p' || !api) {
      return Promise.reject(new Error('terminal stream resume is P2P-only'));
    }
    return api.resumeStream(this.sessionName, epoch, afterSeq);
  }

  private setupRelay(): void {
    const svc = this.serverConnection!;

    // Use sessionName for relay subscriptions — agent protocol messages
    // carry session_name (short name), not session_id (agent:name format).
    this.relayUnsubOutput = svc.onRelayOutput(this.sessionName, (data: Uint8Array, bootstrap?: TerminalBootstrap) => {
      if (!this.disposed) {
        this.onOutput?.(data, bootstrap);
      }
    });

    this.relayUnsubResize = svc.onRelayResize(
      this.sessionName,
      (cols: number, rows: number) => {
        if (!this.disposed) {
          this.onResize?.(cols, rows);
        }
      },
    );

    // The agent's applied cursor, on the relay lane (#1307 SC-13).
    //
    // It arrives here rather than through a reply because the Server forwards
    // every agent frame to the browser unchanged — the notification is on the
    // wire either way. What was missing was this subscription: the frame
    // reached the browser and nothing read it, so a relay client's queue never
    // drained and every chunk it had ever sent stayed pending until the TTL
    // took it.
    this.relayUnsubInputAck = svc.onRelayInputAck(this.sessionName, (ack) => {
      if (this.disposed) { return; }
      this.applyInputAck(ack);
    });
  }
}
