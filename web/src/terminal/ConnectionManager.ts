import type { ConnectionOptions } from './types';
import type { P2PConnectionState, P2PMessage } from '@/services/socket/p2pTypes';
import type { TerminalTransport } from './transport/TerminalTransport';

let _msgCounter = 0;
function generateId(): string {
  return `web-${Date.now()}-${++_msgCounter}`;
}

function encodeB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) { binary += String.fromCharCode(bytes[i]); }
  return btoa(binary);
}

/**
 * Decode a base64 string to raw bytes.
 *
 * IMPORTANT: returns Uint8Array, NOT a decoded string.  Terminal output is
 * a stream of raw bytes (ANSI escapes + UTF-8 text + arbitrary octets).
 * Passing bytes through TextDecoder would replace invalid-UTF-8 octets
 * with U+FFFD replacement characters, corrupting the byte stream before
 * xterm.js can interpret it.  xterm.js's `write()` accepts Uint8Array
 * natively, so we pass the raw bytes directly.
 */
function decodeB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}

export class ConnectionManager implements TerminalTransport {
  readonly mode: 'p2p' | 'relay';
  private sessionName: string;
  private p2pConnection?: ConnectionOptions['p2pConnection'];
  private serverConnection?: ConnectionOptions['serverConnection'];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private relayUnsubOutput: (() => void) | null = null;
  private relayUnsubState: (() => void) | null = null;
  private relayUnsubResize: (() => void) | null = null;
  private p2pUnsubMessage: (() => void) | null = null;
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

  onStateChange: ((state: P2PConnectionState) => void) | null = null;
  onOutput: ((data: Uint8Array) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.mode = options.mode;
    this.sessionName = options.sessionName;
    this.p2pConnection = options.p2pConnection;
    this.serverConnection = options.serverConnection;
    this.isAttached = options.isAttached ?? (() => false);

    if (this.mode === 'p2p' && this.p2pConnection) {
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
    if (this.mode === 'p2p' && this.p2pConnection) {
      this.p2pConnection.sendMessage({
        msg_type: 'terminal.input',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: this.sessionName, data: encodeB64(data) },
      });
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
    if (this.mode === 'p2p' && this.p2pConnection) {
      this.p2pConnection.sendMessage({
        msg_type: 'terminal.resize',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: this.sessionName, cols, rows },
      });
    } else if (this.mode === 'relay' && this.serverConnection?.isReady()) {
      this.serverConnection.sendRelayResize(this.sessionName, cols, rows);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.p2pUnsubMessage?.();
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
    const conn = this.p2pConnection!;

    this.p2pUnsubMessage = conn.onMessage((msg: P2PMessage) => {
      if (this.disposed) { return; }

      if (msg.msg_type === '__binary__') {
        this.onOutput?.(new Uint8Array(msg.payload as ArrayBuffer));
        return;
      }

      switch (msg.msg_type) {
        case 'terminal.output': {
          const data = (msg.payload as Record<string, unknown>)?.data as string | undefined;
          if (data) {
            this.onOutput?.(decodeB64(data));
          }
          break;
        }
        case 'terminal.resize': {
          const { cols, rows } = msg.payload as { cols: number; rows: number };
          this.onResize?.(cols, rows);
          break;
        }
        case 'ok':
          break;
        case 'error':
          if (msg.id?.startsWith('ka-')) { break; }
          // Belt-and-suspenders: the outbound gate should make `not_attached`
          // unreachable, but if a race slips through (e.g. a stale message
          // already on the wire before the gate landed) we swallow it here
          // rather than surface a transient timing race as a user-visible
          // toast.  Real agent errors (session actually missing) surface via
          // the client.attach error path instead.
          {
            const errMsg = ((msg.payload as Record<string, unknown>)?.message as string) || '';
            if (!this.isAttached() && /not attached/i.test(errMsg)) {
              break;
            }
            this.onError?.(new Error(errMsg || 'Remote error'));
          }
          break;
        case 'keepalive.pong':
          break;
        default:
          break;
      }
    });

    // Pure transport: ConnectionManager sends/receives messages but never
    // initiates protocol actions.  client.attach timing is owned by the
    // React layer (terminalSessionStateAtom).
    this.pingTimer = setInterval(() => {
      if (this.disposed) { return; }
      conn.sendMessage({
        msg_type: 'keepalive.ping',
        id: `ka-${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {},
      });
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
