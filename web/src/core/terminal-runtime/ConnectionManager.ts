import type { ConnectionOptions } from './types';
import type { ConnectionState } from '@/services/socket/types';
import type { TerminalTransport } from './transport/TerminalTransport';

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
  private isAttached: () => boolean;

  onStateChange: ((state: ConnectionState) => void) | null = null;
  onOutput: ((data: Uint8Array) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.mode = options.mode;
    this.sessionName = options.sessionName;
    this.agentApi = options.agentApi;
    this.serverConnection = options.serverConnection;
    this.isAttached = options.isAttached ?? (() => false);

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

    this.p2pUnsubOutput = api.onOutput((data: Uint8Array) => {
      if (!this.disposed) {
        this.onOutput?.(data);
      }
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
      try {
        api.ping();
      } catch { /* transport reconnecting — the runtime reconnect budget owns recovery */ }
    }, 30_000);
  }

  private setupRelay(): void {
    const svc = this.serverConnection!;

    // Use sessionName for relay subscriptions — agent protocol messages
    // carry session_name (short name), not session_id (agent:name format).
    this.relayUnsubOutput = svc.onRelayOutput(this.sessionName, (data: Uint8Array) => {
      if (!this.disposed) {
        this.onOutput?.(data);
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
