import { createContext, useContext } from 'react';
import type { WebSocketService } from '../services/websocket';

/** WebSocket context — use `<WebSocketContext.Provider>` in App.tsx. */
export const WebSocketContext = createContext<WebSocketService | null>(null);

/**
 * Access the current WebSocket service from any component in the tree.
 * Must be rendered inside `<WebSocketContext.Provider>` (set up in `App.tsx`).
 *
 * @param override — optional explicit instance, mainly for tests that need
 *   to inject a mock without mounting the provider.
 */
export function useWebSocket(override?: WebSocketService): WebSocketService {
  const ctx = useContext(WebSocketContext);
  const svc = override ?? ctx;
  if (!svc) {
    throw new Error('useWebSocket must be used inside <WebSocketContext.Provider>');
  }
  return svc;
}
