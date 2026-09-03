import type { ConnectionStatus } from '@/types';

/**
 * Narrow relay capability surface SessionRuntime needs from the server
 * WebSocket. WebSocketService satisfies it structurally; injecting the full
 * service would couple the runtime to the singleton facade.
 */
export interface RelayServerConnection {
  onConnectionChange(cb: (status: ConnectionStatus) => void): () => void;
  beginRelay(sessionId: string, relayUrl?: string, cols?: number, rows?: number): void;
  isAuthenticated(): boolean;
  getConnectionStatus(): ConnectionStatus;
}
