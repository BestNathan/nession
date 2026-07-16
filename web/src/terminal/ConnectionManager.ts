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

function decodeB64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
  return new TextDecoder().decode(bytes);
}

const RELAY_MAX_ATTEMPTS = 10;

export class ConnectionManager {
  private mode: 'p2p' | 'relay';
  private sessionName: string;
  private sessionId: string;
  private p2pConnection?: ConnectionOptions['p2pConnection'];
  private serverConnection?: ConnectionOptions['serverConnection'];

  private reconnectAttempt = 0;
  private relayLost = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private relayUnsubOutput: (() => void) | null = null;
  private relayUnsubState: (() => void) | null = null;
  private p2pUnsubMessage: (() => void) | null = null;
  private disposed = false;

  onStateChange: ((state: ConnectionState, attempt: number) => void) | null = null;
  onOutput: ((data: string) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(options: ConnectionOptions) {
    this.mode = options.mode;
    this.sessionName = options.sessionName;
    this.sessionId = options.sessionId;
    this.p2pConnection = options.p2pConnection;
    this.serverConnection = options.serverConnection;

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
        this.serverConnection.sendTerminalInput(this.sessionId, data);
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Forward the current xterm cols/rows to the agent so tmux's per-client
   * viewport (via `refresh-client -C W,H`) matches this browser's size.
   * Callers should debounce burst events (e.g. window drag) before invoking.
   */
  resize(cols: number, rows: number): void {
    if (this.disposed) { return; }
    try {
      if (this.mode === 'p2p' && this.p2pConnection?.connectionState === 'connected') {
        this.p2pConnection.sendMessage({
          msg_type: 'terminal.resize',
          id: generateId(),
          timestamp: Math.floor(Date.now() / 1000),
          payload: { session_name: this.sessionName, width: cols, height: rows },
        });
      } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
        this.serverConnection.sendTerminalResize(this.sessionId, cols, rows);
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async attach(): Promise<void> {
    if (this.disposed) { return; }
    if (this.mode === 'p2p' && this.p2pConnection) {
      // Wait for the socket to actually be OPEN before sending. The engine
      // schedules attach() on a 50ms timer after terminal.open(), but a real
      // network WebSocket handshake takes longer than that — sendMessage()
      // silently no-ops while readyState !== OPEN, so firing immediately drops
      // the client.attach frame and tmux never redraws (blank terminal). This
      // mirrors fileOps.sendRequest, which already waits before sending.
      try {
        await this.p2pConnection.waitForConnection();
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.disposed) { return; }
      // A bare `client.attach` is enough: the agent's `tmux attach-session`
      // redraws the full screen on attach. We deliberately do NOT inject a
      // trailing `\r` — that executed an empty command in the shell, leaving a
      // stray blank prompt line on every (re)attach.
      this.p2pConnection.sendMessage({
        msg_type: 'client.attach',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: this.sessionName },
      });
    } else if (this.mode === 'relay' && this.serverConnection) {
      try {
        await this.serverConnection.requestAttach(this.sessionId, 'relay');
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** Re-issue attach after a reconnect so tmux redraws the full screen. */
  async reattach(): Promise<void> {
    return this.attach();
  }

  dispose(): void {
    this.disposed = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.p2pUnsubMessage?.();
    this.relayUnsubOutput?.();
    this.relayUnsubState?.();
    this.onStateChange = null;
    this.onOutput = null;
    this.onError = null;
    this.onDisconnect = null;
  }

  private setupP2P(): void {
    const conn = this.p2pConnection!;

    this.p2pUnsubMessage = conn.onMessage((msg: P2PMessage) => {
      if (this.disposed) { return; }

      if (msg.msg_type === '__binary__') {
        this.onOutput?.(new TextDecoder().decode(msg.payload as ArrayBuffer));
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

    this.relayUnsubOutput = svc.onTerminalOutput(this.sessionId, (data: string) => {
      if (!this.disposed) {
        this.onOutput?.(data);
      }
    });

    this.relayUnsubState = svc.onConnectionChange((status) => {
      if (this.disposed) { return; }
      if (status === 'disconnected' || status === 'connecting') {
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
