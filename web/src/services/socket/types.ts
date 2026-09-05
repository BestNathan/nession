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

export interface MessageRouter {
  send(message: SocketMessage): void;
  subscribe(type: string, handler: (payload: unknown, raw: SocketMessage) => void): () => void;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  /** Reject all in-flight correlated requests (transport generation loss). */
  failPending(error: Error): void;
  dispose(): void;
}

export interface SocketClient extends MessageRouter {
  readonly connectionState: ConnectionState;
  connect(): void;
  disconnect(): void;
  close(): void;
  waitForConnection(timeoutMs?: number): Promise<void>;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  onBinary(handler: (data: ArrayBuffer) => void): () => void;
}

/** Subset for terminal + file consumers that do not need full lifecycle control. */
export type AgentConnection = Pick<
  SocketClient,
  'send' | 'subscribe' | 'connectionState' | 'waitForConnection' | 'request'
>;

/** Transport-facing surface given to the post-open handshake (not readiness-gated). */
export interface HandshakeSurface {
  send(type: string, payload: Record<string, unknown>): void;
  request<T>(type: string, payload: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

/** Capability-facing surface — everything a plugin may do with the transport. */
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

export interface CapabilityPlugin {
  readonly name: string;
  install(connection: PluginSurface): () => void;
}

export interface WebSocketServiceOptions {
  handshake?: (surface: HandshakeSurface) => Promise<void>;
  maxReconnectAttempts?: number; // default 10
  reconnectBaseDelay?: number;   // default 1_000, exp backoff, cap 30_000
  onError?: (error: Error) => void;
}
