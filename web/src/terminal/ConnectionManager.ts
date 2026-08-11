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

export class ConnectionManager {
  private mode: 'p2p' | 'relay';
  private sessionName: string;
  private p2pConnection?: ConnectionOptions['p2pConnection'];
  private serverConnection?: ConnectionOptions['serverConnection'];
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
    if (this.mode === 'p2p' && this.p2pConnection) {
      this.p2pConnection.sendMessage({
        msg_type: 'terminal.input',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: this.sessionName, data: encodeB64(data) },
      });
    } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
      this.serverConnection.sendRelayInput(this.sessionName, data);
    }
  }

  /** Send a terminal resize to the agent (client → tmux direction). */
  sendResize(cols: number, rows: number): void {
    if (this.disposed) { return; }
    if (this.mode === 'p2p' && this.p2pConnection) {
      this.p2pConnection.sendMessage({
        msg_type: 'terminal.resize',
        id: generateId(),
        timestamp: Math.floor(Date.now() / 1000),
        payload: { session_name: this.sessionName, cols, rows },
      });
    } else if (this.mode === 'relay' && this.serverConnection?.isConnected()) {
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
      if (status === 'authenticated') {
        this.onStateChange?.('connected', 0);
      } else if (status === 'disconnected') {
        this.onStateChange?.('lost', 0);
      }
    });
  }
}
