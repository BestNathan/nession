import type { ConnectionState, ConnectionOptions } from './types';
import type { P2PMessage } from '../hooks/useP2PConnection';

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

const RELAY_MAX_ATTEMPTS = 10;

export class ConnectionManager {
  private mode: 'p2p' | 'relay';
  /** Public so TerminalView's 50ms timer can branch on transport. */
  get isP2P(): boolean { return this.mode === 'p2p'; }
  private sessionName: string;
  private sessionId: string;
  private p2pConnection?: ConnectionOptions['p2pConnection'];
  private serverConnection?: ConnectionOptions['serverConnection'];

  /** Most recent client→agent resize, used on reconnect so tmux isn't
   *  re-created at the default 80×24. */
  private lastResize: { cols: number; rows: number } | null = null;
  private reconnectAttempt = 0;
  private relayLost = false;
  /** True once the initial relay has been established.
   *  Resets on disconnect so reconnection re-sends the attach request. */
  private relayInitiallyAttached = false;
  /** True once the initial P2P client.attach has been sent.
   *  Resets on dispose so session switches re-send the attach. */
  private p2pAttachSent = false;
  /** Manual relay endpoint URL from the attach dialog. */
  private relayUrl: string | null | undefined;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private relayUnsubOutput: (() => void) | null = null;
  private relayUnsubState: (() => void) | null = null;
  private relayUnsubResize: (() => void) | null = null;
  private p2pUnsubMessage: (() => void) | null = null;
  private disposed = false;

  onStateChange: ((state: ConnectionState, attempt: number) => void) | null = null;
  onOutput: ((data: Uint8Array) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onResize: ((cols: number, rows: number) => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.mode = options.mode;
    this.sessionName = options.sessionName;
    this.sessionId = options.sessionId;
    this.p2pConnection = options.p2pConnection;
    this.serverConnection = options.serverConnection;
    this.relayUrl = options.relayUrl;

    if (this.mode === 'p2p' && this.p2pConnection) {
      this.setupP2P();
    } else if (this.mode === 'relay' && this.serverConnection) {
      this.setupRelay();
    }
  }

  send(data: string): void {
    if (this.disposed) { return; }
    try {
      if (this.mode === 'p2p' && this.p2pConnection?.connectionState === 'connected') {
        this.p2pConnection.sendMessage({
          msg_type: 'terminal.input',
          id: generateId(),
          timestamp: Math.floor(Date.now() / 1000),
          payload: { session_name: this.sessionName, data: encodeB64(data) },
        });
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendRelayInput(this.sessionName, data);
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Send a terminal resize to the agent (client → tmux direction). */
  sendResize(cols: number, rows: number): void {
    if (this.disposed) { return; }
    this.lastResize = { cols, rows };
    try {
      if (this.mode === 'p2p' && this.p2pConnection?.connectionState === 'connected') {
        this.p2pConnection.sendMessage({
          msg_type: 'terminal.resize',
          id: generateId(),
          timestamp: Math.floor(Date.now() / 1000),
          payload: { session_name: this.sessionName, cols, rows },
        });
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendRelayResize(this.sessionName, cols, rows);
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async attachP2P(w?: number, h?: number): Promise<void> {
    const conn = this.p2pConnection!;
    if (this.p2pAttachSent) {
      // Initial attach already sent from setupP2P().  Don't send a second
      // client.attach just for the ResizeObserver dimensions — the agent
      // would process two attaches and produce redundant output.  Send a
      // terminal.resize instead (the ResizeObserver already fires one, but
      // the 50ms timer may have fresher values).
      if (w !== undefined && h !== undefined) {
        this.sendResize(w, h);
      }
      return;
    }
    try { await conn.waitForConnection(); } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.disposed) { return; }
    this.p2pAttachSent = true;
    conn.sendMessage({
      msg_type: 'client.attach',
      id: generateId(),
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        session_name: this.sessionName,
        ...(w !== undefined && h !== undefined ? { width: w, height: h } : {}),
      },
    });
  }

  async attach(width?: number, height?: number): Promise<void> {
    if (this.disposed) { return; }
    const w = width ?? this.lastResize?.cols;
    const h = height ?? this.lastResize?.rows;
    if (this.mode === 'p2p' && this.p2pConnection) {
      await this.attachP2P(w, h);
    } else if (this.mode === 'relay' && this.serverConnection) {
      // Phase 2 of relay attach: the Terminal is now mounted and subscribed
      // to terminal.output.  Tell the server to enter relay forwarding.
      // No await — beginRelay is fire-and-forget; terminal data flows
      // through the existing WebSocket.
      if (!this.relayInitiallyAttached) {
        this.relayInitiallyAttached = true;
        this.serverConnection.beginRelay(
          this.sessionId,
          this.relayUrl ?? undefined,
          w,
          h,
        );
        return;
      }
      // Reconnection: re-send beginRelay with last known viewport so the
      // server opens the agent relay at the correct size.
      try {
        this.serverConnection.beginRelay(this.sessionId, this.relayUrl ?? undefined, w, h);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** Re-issue attach after a reconnect so tmux redraws the full screen. */
  async reattach(): Promise<void> {
    this.p2pAttachSent = false;
    return this.attach();
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
          this.onError?.(new Error(
            ((msg.payload as Record<string, unknown>)?.message as string) || 'Remote error',
          ));
          break;
        case 'keepalive.pong':
          break;
        default:
          break;
      }
    });

    // Attach is driven by the React layer: Terminal.tsx watches p2pState
    // transitions and calls view.reattach() when the socket reaches
    // 'connected'.  This keeps ConnectionManager a pure transport layer —
    // it sends/receives messages but doesn't initiate protocol actions.
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
    this.relayUnsubOutput = svc.onTerminalOutput(this.sessionName, (data: Uint8Array) => {
      if (!this.disposed) {
        this.onOutput?.(data);
      }
    });

    this.relayUnsubResize = svc.onTerminalResize(
      this.sessionName,
      (cols: number, rows: number) => {
        if (!this.disposed) {
          this.onResize?.(cols, rows);
        }
      },
    );

    this.relayUnsubState = svc.onConnectionChange((status) => {
      if (this.disposed) { return; }
      if (status === 'disconnected' || status === 'connecting') {
        // Reset so reconnection re-sends the relay attach request.
        if (status === 'disconnected') {
          this.relayInitiallyAttached = false;
        }
        if (this.relayLost) { return; }
        const next = this.reconnectAttempt + 1;
        if (next > RELAY_MAX_ATTEMPTS) {
          this.relayLost = true;
          this.setState('lost', RELAY_MAX_ATTEMPTS);
        } else {
          this.setState('reconnecting', next);
        }
      } else if (status === 'authenticated') {
        this.relayLost = false;
        this.setState('connected', 0);
        this.attach().catch(() => {});
      }
    });
  }

  private setState(state: ConnectionState, attempt: number): void {
    this.reconnectAttempt = attempt;
    this.onStateChange?.(state, attempt);
    if (state === 'lost') {
      setTimeout(() => {
        if (!this.disposed) { this.onDisconnect?.(); }
      }, 3000);
    }
  }
}
