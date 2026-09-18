export interface SocketMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: unknown;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface RequestOptions {
  timeoutMs?: number;
}

/** Transport-facing surface given to the post-open handshake (not readiness-gated). */
export interface HandshakeSurface {
  send(type: string, payload: Record<string, unknown>): void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

/** Plugin-facing surface — everything a plugin may do with the transport. */
export interface PluginSurface {
  readonly connectionState: ConnectionState;
  send(type: string, payload: Record<string, unknown>): void;
  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
  waitForConnection(timeoutMs?: number): Promise<void>;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
}

/**
 * A wire-protocol adapter bound to a connection.
 *
 * Named for what it plugs *into*, not for what it serves. Implementors are the
 * request/response families a connection speaks — `file.*`, `session.*`,
 * `extension.claude_code.*` — installed once per service lifetime and never on
 * reconnect.
 *
 * It was called `CapabilityPlugin` until #801, which put one word on two
 * unrelated things. **Product Capability** is the discoverable/activatable
 * concept with a presence state that a user meets in the UI; a transport plugin
 * has no presence, is never activated, and is invisible to the user. Keeping a
 * single term for both made every sentence about capabilities ambiguous — which
 * is why this one is named after the layer it belongs to instead.
 */
export interface TransportPlugin {
  readonly name: string;
  install(connection: PluginSurface): () => void;
}

export interface WebSocketServiceOptions {
  handshake?: (surface: HandshakeSurface) => Promise<void>;
  maxReconnectAttempts?: number; // default 10
  reconnectBaseDelay?: number;   // default 1_000, exp backoff, cap 30_000
  onError?: (error: Error) => void;
}
