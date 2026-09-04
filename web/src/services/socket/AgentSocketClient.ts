import { SocketCore } from './SocketCore';
import { buildAgentWsUrl, type AgentSocketClientConfig } from './agentSocketUtils';
import type { ConnectionState, RequestOptions, SocketClient, SocketMessage } from './types';

/** Agent endpoint facade over the shared browser WebSocket lifecycle. */
export class AgentSocketClient implements SocketClient {
  private readonly core: SocketCore;
  private config: AgentSocketClientConfig;

  constructor(config: AgentSocketClientConfig) {
    this.config = { ...config };
    this.core = new SocketCore({
      url: buildAgentWsUrl(config.agentUrl, config.connectionToken),
      maxReconnectAttempts: config.maxReconnectAttempts,
      reconnectBaseDelay: config.reconnectBaseDelay,
      onError: config.onError,
    });
  }

  get connectionState(): ConnectionState {
    return this.core.connectionState;
  }

  get reconnectAttempts(): number {
    return this.core.reconnectAttempts;
  }

  /** @deprecated Terminal code should use send() with SocketMessage. */
  sendMessage(message: Record<string, unknown>): void {
    this.send({
      msg_type: String(message.msg_type ?? ''),
      id: String(message.id ?? ''),
      timestamp: Number(message.timestamp ?? Date.now()),
      payload: message.payload,
    });
  }

  /** @deprecated Terminal code should subscribe by message type. */
  onMessage(handler: (message: SocketMessage) => void): () => void {
    return this.core.onMessage(handler);
  }

  get reconnectAttempt(): number {
    return this.reconnectAttempts;
  }

  connect(): void {
    void this.core.connect().catch(() => {});
  }

  close(): void {
    this.core.close();
  }

  disconnect(): void {
    this.core.disconnect();
  }

  forceReconnect(): void {
    this.core.reconnectNow();
  }

  configure(next: Partial<AgentSocketClientConfig>): boolean {
    const previousUrl = buildAgentWsUrl(this.config.agentUrl, this.config.connectionToken);
    this.config = { ...this.config, ...next };
    const nextUrl = buildAgentWsUrl(this.config.agentUrl, this.config.connectionToken);
    if (nextUrl === previousUrl) {
      return false;
    }

    return this.core.configure({
      url: nextUrl,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectBaseDelay: this.config.reconnectBaseDelay,
    });
  }

  send(message: SocketMessage): void {
    this.core.send(message);
  }

  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void {
    return this.core.subscribe(type, handler);
  }

  request<T>(
    type: string,
    payload: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    return this.core.request<T>(type, payload, options);
  }

  failPending(error: Error): void {
    this.core.failPending(error);
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    return this.core.onBinary(handler);
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    return this.core.onConnectionStateChange(handler);
  }

  /** @deprecated Use subscribe() with a message type in new code. */
  onLegacyMessage(handler: (message: SocketMessage) => void): () => void {
    return this.core.onMessage(handler);
  }

  waitForConnection(timeoutMs?: number): Promise<void> {
    return this.core.waitForConnection(timeoutMs);
  }

  dispose(): void {
    this.core.dispose();
  }
}
