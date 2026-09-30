import type { ConnectionOptions } from './types';
import type { ConnectionState } from '@/platform/socket/types';
import type { TerminalTransport } from './transport/TerminalTransport';
import type { TerminalBootstrap } from './bootstrap';
import { applyTerminalStreamEvents } from './streamApply';

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
  private streamEpoch: number | null = null;
  private lastStreamSeq: number | null = null;
  private streamResumeInFlight = false;
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
      void this.handleStreamFrame(frame.streamEpoch, frame.streamSeq, () => {
        this.onOutput?.(frame.data, frame.bootstrap);
      });
    });

    this.p2pUnsubResize = api.onResize((cols: number, rows: number) => {
      if (!this.disposed) {
        this.onResize?.(cols, rows);
      }
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
    if (streamEpoch === undefined) {
      return;
    }
    // Never move the cursor backwards within one epoch. A live frame can
    // already have advanced it past the cursor the attach response carries, and
    // regressing it makes the gap fetch below re-apply output that has already
    // been written — the duplication measured as `out seq=1` delivered twice
    // (#1148). Across an epoch change the sequences are not comparable, so the
    // seed wins there.
    const sameEpoch = this.streamEpoch === streamEpoch;
    this.streamEpoch = streamEpoch;
    const seed = streamCursor ?? null;
    this.lastStreamSeq =
      sameEpoch && this.lastStreamSeq !== null && seed !== null
        ? Math.max(this.lastStreamSeq, seed)
        : seed;
    if (this.mode === 'p2p' && this.agentApi && this.lastStreamSeq !== null) {
      void this.fetchStreamGap(this.lastStreamSeq);
    }
  }

  private async handleStreamFrame(
    streamEpoch: number | undefined,
    streamSeq: number | undefined,
    deliver: () => void,
  ): Promise<void> {
    if (streamEpoch === undefined || streamSeq === undefined) {
      deliver();
      return;
    }
    if (this.streamEpoch === null) {
      this.streamEpoch = streamEpoch;
      this.lastStreamSeq = streamSeq;
      deliver();
      return;
    }
    if (streamEpoch !== this.streamEpoch) {
      this.streamEpoch = streamEpoch;
      this.lastStreamSeq = null;
      await this.fetchStreamGap(0);
    } else if (this.lastStreamSeq !== null && streamSeq > this.lastStreamSeq + 1) {
      await this.fetchStreamGap(this.lastStreamSeq);
    }
    // A replay walks the agent's log with no upper bound — `events_since`
    // returns every event after the cursor, INCLUDING the frame arriving right
    // now. Delivering it again writes the same bytes to the terminal twice,
    // which is what doubled P2P output: xterm answered each DA/OSC query twice
    // because it received each query twice (#1148). Relay never hit this,
    // because `fetchStreamGap` only runs in P2P.
    //
    // The cursor the replay left behind is the arbiter, and it suppresses the
    // frame only when the replay genuinely reached it — if the log was capped
    // and did not contain this frame, `lastStreamSeq` stays behind it and the
    // live delivery is the only copy.
    if (this.lastStreamSeq !== null && streamSeq <= this.lastStreamSeq) {
      return;
    }
    this.lastStreamSeq = streamSeq;
    deliver();
  }

  private async fetchStreamGap(afterSeq: number): Promise<void> {
    if (
      this.disposed ||
      this.streamResumeInFlight ||
      this.mode !== 'p2p' ||
      !this.agentApi ||
      this.streamEpoch === null
    ) {
      return;
    }
    this.streamResumeInFlight = true;
    try {
      const result = await this.agentApi.resumeStream(
        this.sessionName,
        this.streamEpoch,
        afterSeq,
      );
      if (!result.epochMatch) {
        this.streamEpoch = result.streamEpoch;
        this.lastStreamSeq = null;
      }
      // A replay must not re-apply what has already been delivered. This is the
      // other half of the guard in `handleStreamFrame`: there, a live frame the
      // replay already carried is dropped; here, a replayed event the live
      // stream already delivered is dropped. Without this half a replay asked
      // for from a stale cursor re-applies the stream on top of itself, and the
      // seed path asks with `after_seq: 0` — measured as `out seq=1` delivered
      // twice and `out seq=5..8` delivered once live and again from the replay
      // (#1148). Every duplicated byte reached xterm twice, so xterm answered
      // each terminal-capability query twice.
      const deliveredUpTo = this.lastStreamSeq;
      const fresh =
        deliveredUpTo === null
          ? result.events
          : result.events.filter((event) => event.streamSeq > deliveredUpTo);
      applyTerminalStreamEvents(fresh, {
        onOutput: (data) => this.onOutput?.(data),
        onResize: (cols, rows) => this.onResize?.(cols, rows),
      });
      const last = fresh.length > 0 ? fresh[fresh.length - 1] : undefined;
      if (last) {
        this.lastStreamSeq = last.streamSeq;
      }
    } catch {
      /* gap recovery is best-effort; live stream continues */
    } finally {
      this.streamResumeInFlight = false;
    }
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
