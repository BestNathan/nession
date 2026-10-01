import type { ConnectionOptions } from './types';
import type { ConnectionState } from '@/platform/socket/types';
import type { TerminalTransport, TerminalInputSeed } from './transport/TerminalTransport';
import { StreamReconciler, type ResumeReply } from './streamReconciler';
import type { TerminalBootstrap } from './bootstrap';
import { PendingInputQueue, type InputQueueBounds } from './inputQueue';

/**
 * How much typed-ahead input this client will hold for a session (#1307).
 *
 * The requirement asks for these to be fixed by measurement of real typing and
 * paste, and that measurement has not been taken — so these are reasoned
 * starting points rather than the settled numbers, and are stated here so the
 * reasoning can be replaced by a figure:
 *
 * * **128 chunks** is far past any reconnect window's worth of fast typing
 *   (ten keys a second for twelve seconds) and far past any single paste, which
 *   arrives as one chunk. Reaching it means the transport has been unable to
 *   deliver for a long time.
 * * **64 KiB** is one large paste, and the bound is deliberately well above any
 *   keyboard burst. A single chunk is always accepted into an empty queue, so
 *   this bounds the *queue*, not the event.
 * * **5 s** is the age at which typed-ahead input stops being "typed ahead".
 *   The failure this prevents is the one the requirement names: bytes typed
 *   during an outage arriving at the shell much later, as if the user had just
 *   typed them, possibly into a different application state than the one they
 *   were typed for.
 */
const INPUT_QUEUE_BOUNDS: InputQueueBounds = {
  maxChunks: 128,
  maxBytes: 64 * 1024,
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
  private relayUnsubState: (() => void) | null = null;
  private relayUnsubResize: (() => void) | null = null;
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
   * Owns the stream cursor and the order frames are applied in (#1303). This
   * class moves bytes and never decides what is next in the timeline: a live
   * frame and a replay answer are handed to the same reconciler, which is the
   * only writer of the cursor.
   */
  private readonly reconciler: StreamReconciler;
  private isAttached: () => boolean;
  /** Notified after input is handed to either transport — see `onInputSent`. */
  private onInputSent: () => void;

  onStateChange: ((state: ConnectionState) => void) | null = null;
  /**
   * Bytes from the agent. `bootstrap` marks the session's history rather than
   * its live output, and carries what the agent said about the snapshot
   * (#321/#1305) — see {@link TerminalTransport.onOutput}. Both paths deliver
   * it: P2P from the frame the agent API decoded, relay from the payload the
   * Server forwarded verbatim.
   */
  onOutput: ((data: Uint8Array, bootstrap?: TerminalBootstrap) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.mode = options.mode;
    this.sessionName = options.sessionName;
    this.agentApi = options.agentApi;
    this.serverConnection = options.serverConnection;
    this.isAttached = options.isAttached ?? (() => false);
    this.onInputSent = options.onInputSent ?? (() => {});
    this.reconciler = new StreamReconciler(
      (epoch, afterSeq) => this.resumeStream(epoch, afterSeq),
      {
        onOutput: (data, bootstrap) => this.onOutput?.(data, bootstrap),
        onResize: (cols, rows) => this.onResize?.(cols, rows),
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
    if (this.mode === 'relay') {
      // The Server's 16 ms merge keeps the newest frame's envelope and
      // concatenates the bytes of the rest, so a sequence range sent through it
      // would describe only the last frame of a burst while carrying all of
      // them — the agent would read it as a gap and refuse. Until that merge
      // carries the range (#1307 stage 4) this path sends unsequenced input,
      // exactly as it did before this contract, and the queue is therefore a
      // buffer rather than a retry log: handed over once, then forgotten.
      for (const data of this.pendingInput.drain()) {
        this.sendRawInput(data);
      }
      return;
    }
    const outbound = this.pendingInput.outbound();
    if (outbound === null) {
      // No epoch yet — either a transport that cannot carry one, or an agent
      // built before this contract. Send unsequenced and do not retain: there
      // is nothing a later retry could be checked against, and holding the
      // bytes would only delay their discard by the TTL.
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
   */
  private sendSequencedInput(data: string, seq: number): void {
    if (this.mode !== 'p2p' || !this.agentApi) { return; }
    const epoch = this.pendingInput.boundTo?.inputEpoch;
    if (epoch === undefined) { return; }
    try {
      this.agentApi.sendInput(this.sessionName, data, {
        inputEpoch: epoch,
        seqStart: seq,
        seqEnd: seq,
      });
    } catch { /* transport reconnecting — the chunk stays pending */ }
  }

  /**
   * Send a terminal resize to the agent (client → tmux direction).
   *
   * Gated on `terminalSessionStateAtom === 'attached'` — while the transport is
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

  private sendResizeRaw(cols: number, rows: number): void {
    if (this.mode === 'p2p' && this.agentApi) {
      try {
        this.agentApi.sendResize(this.sessionName, cols, rows);
      } catch { /* transport reconnecting — coalesced via the isAttached gate */ }
    } else if (this.mode === 'relay' && this.serverConnection?.isReady()) {
      this.serverConnection.sendRelayResize(this.sessionName, cols, rows);
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
    this.relayUnsubState?.();
    this.relayUnsubResize?.();
    this.onStateChange = null;
    this.onOutput = null;
    this.onError = null;
    this.onDisconnect = null;
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
      this.pendingInput.acknowledge(ack.inputEpoch, ack.appliedThrough);
      if (ack.controlGeneration !== undefined) {
        this.noteControlGeneration(ack.controlGeneration);
      }
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
    // React layer (terminalSessionStateAtom).
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
   * **P2P only.** The relay's merge would destroy the position a sequence
   * carries (see {@link flushInputBuffer}), so a relay client never binds and
   * its queue keeps the buffer semantics it had before this contract. Enabling
   * it is part of stage 4, together with the merge that makes it sound.
   */
  seedInputCursor(seed: TerminalInputSeed | undefined): void {
    if (this.disposed || this.mode !== 'p2p' || !seed) { return; }
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

    // Only the durable edges are reported: the new transport's
    // post-handshake 'connected' (old 'authenticated') and the
    // budget-exhausted 'disconnected'. 'connecting'/'reconnecting' are the
    // intra-budget loss window, surfaced by the lifecycle hooks — mirroring
    // the old facade, which collapsed them onto 'connecting' and no-op'd.
    this.relayUnsubState = svc.onConnectionStateChange((state) => {
      if (this.disposed) { return; }
      if (state === 'connected') {
        this.onStateChange?.('connected');
      } else if (state === 'disconnected') {
        this.onStateChange?.('disconnected');
      }
    });
  }
}
