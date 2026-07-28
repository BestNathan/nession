// WebSocket service for nession Web UI
// Backward-compatible shim — re-exports from the modular websocket/ module.

export { WebSocketService } from './websocket/WebSocketService';
export type { WebSocketPlugin, WebSocketServiceCore } from './websocket/types';

// Singleton management (kept here for backward compatibility)
import { WebSocketService } from './websocket/WebSocketService';

let wsServiceInstance: WebSocketService | null = null;

export function getWebSocketService(): WebSocketService | null {
  return wsServiceInstance;
}

export function createWebSocketService(url: string, authToken: string): WebSocketService {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
  }

  wsServiceInstance = new WebSocketService(url, authToken);
  return wsServiceInstance;
}

export function destroyWebSocketService(): void {
  if (wsServiceInstance) {
    wsServiceInstance.disconnect();
    wsServiceInstance = null;
  }
}
