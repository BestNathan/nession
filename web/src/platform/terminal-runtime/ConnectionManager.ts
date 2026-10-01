import type { ConnectionOptions } from './types';
import type { ConnectionState } from '@/platform/socket/types';
import type { TerminalTransport } from './transport/TerminalTransport';
import { StreamReconciler, type ResumeReply } from './streamReconciler';
import type { TerminalBootstrap } from './bootstrap';

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
  private disposed = false;
  /** Input typed before client.attach is acked — flushed once attached. */
  private inputBuffer: string[] = [];
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

  send(data: string): void {
    if (this.disposed) { return; }
    if (!this.isAttached()) {
      this.inputBuffer.push(data);
      return;
    }
    this.flushInputBuffer();
    this.sendRaw(data);
  }

  /**
   * Flush any input buffered before the session was attached.  Called by the
   * TerminalWorkspace effect when entering 'attached' so queued keystrokes
   * don't sit in the buffer until the next user action.
   */
  flushInputBuffer(): void {
    if (this.disposed || this.inputBuffer.length === 0) { return; }
    const buffered = this.inputBuffer.splice(0);
    for (const d of buffered) { this.sendRaw(d); }
  }

  /** Send input unconditionally — used by send() once the session is attached. */
  private sendRaw(data: string): void {
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
    // Reported for both transports, and even when the branch above threw: a
    // refused send is exactly the case worth questioning, and the owner decides
    // for itself whether a check is warranted right now (#1264).
    this.onInputSent();
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

  dispose(): void {
    this.disposed = true;
    this.reconciler.dispose();
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.p2pUnsubOutput?.();
    this.p2pUnsubResize?.();
    this.p2pUnsubError?.();
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
