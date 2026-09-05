import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';

type RelayOutputCallback = (data: Uint8Array) => void;
type RelayResizeCallback = (cols: number, rows: number) => void;

/**
 * Decode base64-encoded terminal data to raw bytes.
 *
 * Returns Uint8Array so that non-UTF-8 octets are preserved. xterm.js
 * accepts Uint8Array in `write()` and interprets the bytes directly as a
 * terminal byte stream (ANSI escapes + text + arbitrary binary). Mirrors the
 * pre-refactor `services/websocket/plugins/EventPlugin.ts` semantics exactly.
 */
export function decodeTerminalData(rawData: string): Uint8Array {
  if (!rawData) {
    return new Uint8Array(0);
  }
  try {
    const binary = atob(rawData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    // Invalid base64 — fall back to encoding the raw string as UTF-8 bytes.
    return new TextEncoder().encode(rawData);
  }
}

/** Session key used by relay frames — session_name (short name), not session_id. */
function getSessionId(payload: Record<string, unknown>): string {
  return (payload.session_name ?? payload.session_id) as string;
}

/**
 * Server (relay) terminal capability — the application's single server
 * connection. Relay traffic (begin/end, terminal I/O proxied by the server)
 * travels this connection, so the plugin owns both the outbound relay
 * lifecycle and the inbound per-session terminal.output / terminal.resize
 * fan-out. Wire strings live only in this file.
 */
export interface TerminalServerApi {
  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void;
  endRelay(sessionId: string): void;
  /** Relay terminal input — base64-wrapped, mirroring the server wire. */
  sendRelayInput(sessionName: string, data: string): void;
  sendRelayResize(sessionName: string, cols: number, rows: number): void;
  /** Subscribe to relay output frames for one session (routed by session_name). */
  onRelayOutput(sessionName: string, cb: RelayOutputCallback): () => void;
  /** Subscribe to relay resize frames for one session (routed by session_name). */
  onRelayResize(sessionName: string, cb: RelayResizeCallback): () => void;
}

/** TextEncoder→binary-string→btoa, matching the server's base64 wire encoding. */
function encodeBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class TerminalServerPlugin implements CapabilityPlugin, TerminalServerApi {
  readonly name = 'terminal-server';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private outputCallbacks = new Map<string, RelayOutputCallback[]>();
  private resizeCallbacks = new Map<string, RelayResizeCallback[]>();

  /**
   * Bind the plugin to the server connection. A later install replaces an
   * earlier binding (same instance, new surface — StrictMode remount); the
   * returned teardown is generation-guarded so a stale release can never
   * detach the newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;

    const unsubs = [
      connection.subscribe('terminal.output', (payload) => {
        this.handleRelayOutput(payload as Record<string, unknown>);
      }),
      connection.subscribe('terminal.resize', (payload) => {
        this.handleRelayResize(payload as Record<string, unknown>);
      }),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
      // A released plugin must never notify stale consumers.
      this.outputCallbacks.clear();
      this.resizeCallbacks.clear();
    };
  }

  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void {
    const payload: Record<string, unknown> = { session_id: sessionId };
    if (relayUrl) {
      payload.relay_url = relayUrl;
    }
    if (cols !== undefined) {
      payload.cols = cols;
    }
    if (rows !== undefined) {
      payload.rows = rows;
    }
    this.requireConnection().send('client.session.relay.begin', payload);
  }

  endRelay(sessionId: string): void {
    this.requireConnection().send('client.session.relay.end', { session_id: sessionId });
  }

  sendRelayInput(sessionName: string, data: string): void {
    const encoded = encodeBase64(data);
    this.requireConnection().send('terminal.input', { session_name: sessionName, data: encoded });
  }

  sendRelayResize(sessionName: string, cols: number, rows: number): void {
    this.requireConnection().send('terminal.resize', { session_name: sessionName, cols, rows });
  }

  onRelayOutput(sessionName: string, cb: RelayOutputCallback): () => void {
    return this.addMapCallback(this.outputCallbacks, sessionName, cb);
  }

  onRelayResize(sessionName: string, cb: RelayResizeCallback): () => void {
    return this.addMapCallback(this.resizeCallbacks, sessionName, cb);
  }

  private handleRelayOutput(payload: Record<string, unknown>): void {
    const sessionId = getSessionId(payload);
    const rawData = (payload.data ?? '') as string;

    // Relay frames wrap bytes in base64; anything else is a plain byte string.
    const isRelay = typeof payload.session_name === 'string' && typeof payload.session_id !== 'string';
    let data: Uint8Array;
    if (isRelay) {
      data = decodeTerminalData(rawData);
    } else {
      data = new TextEncoder().encode(rawData);
    }

    const callbacks = this.outputCallbacks.get(sessionId);
    if (callbacks) {
      for (const cb of callbacks) {
        cb(data);
      }
    }
  }

  private handleRelayResize(payload: Record<string, unknown>): void {
    const sessionId = getSessionId(payload);
    const cols = (payload.cols as number) ?? 0;
    const rows = (payload.rows as number) ?? 0;

    const callbacks = this.resizeCallbacks.get(sessionId);
    if (callbacks) {
      for (const cb of callbacks) {
        cb(cols, rows);
      }
    }
  }

  private addMapCallback<T>(map: Map<string, T[]>, key: string, callback: T): () => void {
    const list = map.get(key);
    if (list) {
      list.push(callback);
    } else {
      map.set(key, [callback]);
    }

    return () => {
      const current = map.get(key);
      if (!current) {
        return;
      }
      const index = current.indexOf(callback);
      if (index > -1) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        map.delete(key);
      }
    };
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('terminal-server feature is not connected');
    }
    return this.connection;
  }
}

/** App-level singleton — one terminal-server binding per server connection lifetime. */
export const terminalServerApi = new TerminalServerPlugin();
