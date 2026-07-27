import type { WebSocketMessage, ConnectionStatus } from '../../types';

export interface WebSocketPlugin {
  name: string;
  install(service: WebSocketServiceCore): void;
  uninstall?(): void;
}

export interface WebSocketServiceCore {
  send(message: WebSocketMessage): void;
  onMessage(type: string, handler: (payload: unknown) => void): () => void;
  request<T>(type: string, payload: unknown): Promise<T>;
  getConnectionStatus(): ConnectionStatus;
  onConnectionChange(callback: (status: ConnectionStatus) => void): () => void;
}
