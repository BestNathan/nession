import type { WebSocketMessage, ConnectionStatus, AttachInfo } from '../../types';

export interface WebSocketPlugin {
  name: string;
  install(service: WebSocketServiceCore): void;
  uninstall?(): void;
}

/**
 * Core WebSocket infrastructure interface.
 *
 * Implemented by {@link WebSocketServiceCoreImpl} and consumed by both
 * the facade (WebSocketService) and all plugins. The core knows nothing
 * about plugins — it only provides connection management, message
 * routing, and request/response correlation.
 */
export interface WebSocketServiceCore {
  // ── Connection lifecycle ──────────────────────────────────
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  isAuthenticated(): boolean;
  getConnectionStatus(): ConnectionStatus;
  onConnectionChange(callback: (status: ConnectionStatus) => void): () => void;

  // ── Message routing ──────────────────────────────────────
  send(message: WebSocketMessage): void;
  onMessage(type: string, handler: (payload: unknown) => void): () => void;

  // ── Request/response ─────────────────────────────────────
  request<T>(type: string, payload: unknown): Promise<T>;
  failPending(error: Error): void;

  // ── Utility ──────────────────────────────────────────────
  generateMessageId(): string;
  getP2PConnectionInfo(attachInfo: AttachInfo): { url: string; token: string } | null;
}
