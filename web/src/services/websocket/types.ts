import type { WebSocketMessage, ConnectionStatus, AttachInfo } from '../../types';

/**
 * A WebSocket capability. Registered on the facade via `WebSocketService.use()`.
 *
 * `install` receives the core and must return a teardown that releases every
 * subscription the plugin made (e.g. the unsubscribe handles returned by
 * `core.onMessage`). The facade stores the teardown and runs it on `unregister`
 * or when a plugin of the same name replaces this one.
 *
 * @deprecated Legacy fallback: if `install` returns nothing, the facade falls
 * back to calling `uninstall()`. New plugins should return a teardown from
 * `install` instead.
 */
export interface WebSocketPlugin {
  name: string;
  install(service: WebSocketServiceCore): (() => void) | void;
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
  request<T>(type: string, payload: unknown, timeoutMs?: number): Promise<T>;
  failPending(error: Error): void;

  // ── Utility ──────────────────────────────────────────────
  generateMessageId(): string;
  getP2PConnectionInfo(attachInfo: AttachInfo): { url: string; token: string } | null;
}
