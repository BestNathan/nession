import type { WebSocketServiceCore } from '../websocket/types';
import type { ConnectionStatus, WebSocketMessage } from '../../types';
import type { ConnectionState, RequestOptions, SocketClient, SocketMessage } from './types';

function mapServerStatus(status: ConnectionStatus): ConnectionState {
  if (status === 'authenticated' || status === 'connected') {
    return 'connected';
  }
  if (status === 'connecting') {
    return 'connecting';
  }
  return 'disconnected';
}

/**
 * Adapter wrapping {@link WebSocketServiceCore} as a {@link SocketClient}.
 * Server connections do not carry binary terminal streams — onBinary is a no-op registry.
 */
export class ServerSocketClient implements SocketClient {
  private readonly binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private disposed = false;

  constructor(private readonly core: WebSocketServiceCore) {}

  get connectionState(): ConnectionState {
    return mapServerStatus(this.core.getConnectionStatus());
  }

  connect(): void {
    void this.core.connect();
  }

  disconnect(): void {
    this.core.disconnect();
  }

  close(): void {
    this.disconnect();
  }

  send(message: SocketMessage): void {
    if (this.disposed) {
      throw new Error('ServerSocketClient disposed');
    }
    this.core.send(message as WebSocketMessage);
  }

  subscribe(
    type: string,
    handler: (payload: unknown, raw: SocketMessage) => void,
  ): () => void {
    return this.core.onMessage(type, (payload) => {
      handler(payload, {
        msg_type: type,
        id: '',
        timestamp: Date.now(),
        payload,
      });
    });
  }

  request<T>(
    type: string,
    payload: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    void options;
    return this.core.request<T>(type, payload);
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => {
      this.binaryHandlers.delete(handler);
    };
  }

  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
    return this.core.onConnectionChange((status) => {
      handler(mapServerStatus(status));
    });
  }

  waitForConnection(timeoutMs = 15_000): Promise<void> {
    if (this.core.isAuthenticated()) {
      return Promise.resolve();
    }
    const status = this.core.getConnectionStatus();
    if (status === 'disconnected') {
      return Promise.reject(new Error('Connection lost'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error('Connection timeout'));
      }, timeoutMs);

      const unsub = this.core.onConnectionChange((next) => {
        if (next === 'authenticated') {
          clearTimeout(timer);
          unsub();
          resolve();
        } else if (next === 'disconnected') {
          clearTimeout(timer);
          unsub();
          reject(new Error('Connection lost'));
        }
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.binaryHandlers.clear();
    this.core.disconnect();
  }
}
