export interface SocketMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: unknown;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface RequestOptions {
  timeoutMs?: number;
  /** When true, retry once after reconnect (explicit opt-in only). */
  retryOnReconnect?: boolean;
}

export interface MessageRouter {
  send(message: SocketMessage): void;
  subscribe(type: string, handler: (payload: unknown, raw: SocketMessage) => void): () => void;
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
