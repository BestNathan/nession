/**
 * WebSocket service — modular, plugin-based architecture.
 *
 * Public API:
 * - {@link WebSocketService} — facade that delegates to plugins
 * - {@link WebSocketPlugin} — plugin interface for extending the service
 * - {@link WebSocketServiceCore} — core interface consumed by plugins
 */

export { WebSocketService } from './WebSocketService';
export type { WebSocketPlugin, WebSocketServiceCore } from './types';
