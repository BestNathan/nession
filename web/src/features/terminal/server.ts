import { decodeTerminalData, encodeBase64 } from './base64';
import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';

type RelayOutputCallback = (data: Uint8Array) => void;
type RelayResizeCallback = (cols: number, rows: number) => void;

/** One registration, tagged with the install generation that created it. */
interface GenerationEntry<T> {
  cb: T;
  generation: number;
}

/**
 * Session key used by relay frames — session_name (short name), not session_id.
 */
function getSessionId(payload: Record<string, unknown>): string {
  return (payload.session_name ?? payload.session_id) as string;
}

/**
 * Server (relay) terminal capability — the application's single server
 * connection. Relay traffic (begin/end, terminal I/O proxied by the server)
 * travels this connection, so the plugin owns both the outbound relay
 * lifecycle and the inbound per-session terminal.output / terminal.resize
 * fan-out. Wire strings live only in this file.
 *
 * Decode semantics: this relay path decodes terminal.output data *tolerantly*
 * (see ./base64) because relay frames arrive via the server's per-connection
 * EventPlugin twin; the P2P path in agent.ts decodes the same wire shape
 * *strictly* (ConnectionManager twin). The relay side identifies base64
 * frames per frame via the isRelay discriminator below.
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

export class TerminalServerPlugin implements CapabilityPlugin, TerminalServerApi {
  readonly name = 'terminal-server';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private outputCallbacks = new Map<string, Array<GenerationEntry<RelayOutputCallback>>>();
  private resizeCallbacks = new Map<string, Array<GenerationEntry<RelayResizeCallback>>>();

  /**
   * Bind the plugin to the server connection. A later install replaces an
   * earlier binding (same instance, new surface — StrictMode remount).
   *
   * Registration lifecycle contract: every onRelayOutput/onRelayResize
   * subscription is tagged with the generation of the install that registered
   * it. The returned teardown releases generation G:
   * - unsubscribes G's surface subscriptions;
   * - if G is still the current release, nulls `this.connection` and clears
   *   ALL registrations (nothing newer exists);
   * - otherwise a newer binding owns the connection — only registrations
   *   tagged G are dropped, so the newer binding's consumers keep firing.
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
        // Current release — no newer binding exists, so every remaining
        // registration belongs to this release. Drop them all.
        this.outputCallbacks.clear();
        this.resizeCallbacks.clear();
      } else {
        // Stale release — a newer binding is active. Drop only the
        // registrations this release created; never touch newer ones.
        this.dropGeneration(generation);
      }
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
      for (const entry of callbacks) {
        entry.cb(data);
      }
    }
  }

  private handleRelayResize(payload: Record<string, unknown>): void {
    const sessionId = getSessionId(payload);
    const cols = (payload.cols as number) ?? 0;
    const rows = (payload.rows as number) ?? 0;

    const callbacks = this.resizeCallbacks.get(sessionId);
    if (callbacks) {
      for (const entry of callbacks) {
        entry.cb(cols, rows);
      }
    }
  }

  private addMapCallback<T>(
    map: Map<string, Array<GenerationEntry<T>>>,
    key: string,
    cb: T,
  ): () => void {
    const entry: GenerationEntry<T> = { cb, generation: this.generation };
    const list = map.get(key);
    if (list) {
      list.push(entry);
    } else {
      map.set(key, [entry]);
    }

    return () => {
      const current = map.get(key);
      if (!current) {
        return;
      }
      const index = current.indexOf(entry);
      if (index > -1) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        map.delete(key);
      }
    };
  }

  /** Drop every registration tagged with `generation` across both maps. */
  private dropGeneration(generation: number): void {
    this.dropGenerationFrom(this.outputCallbacks, generation);
    this.dropGenerationFrom(this.resizeCallbacks, generation);
  }

  private dropGenerationFrom<T>(
    map: Map<string, Array<GenerationEntry<T>>>,
    generation: number,
  ): void {
    for (const [key, list] of map) {
      const kept = list.filter((entry) => entry.generation !== generation);
      if (kept.length === 0) {
        map.delete(key);
      } else if (kept.length !== list.length) {
        map.set(key, kept);
      }
    }
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
