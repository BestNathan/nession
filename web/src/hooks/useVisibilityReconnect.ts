import { useEffect } from 'react';
import type { WebSocketService } from '../services/websocket';

/**
 * When the tab becomes visible after being backgrounded (e.g. mobile app
 * switch), check whether the WebSocket died while we were away and trigger
 * an immediate reconnect instead of waiting for the backoff timer — which
 * the browser may have throttled or paused during suspension.
 */
export function useVisibilityReconnect(
  wasEverAuthed: boolean,
  wsService: WebSocketService | null,
): void {
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') { return; }
      if (!wasEverAuthed) { return; }
      if (!wsService) { return; }
      if (wsService.isConnected()) { return; }

      console.log('[visibility] Tab became visible — reconnecting WebSocket');
      wsService.connect().catch((err) => {
        console.error('[visibility] Reconnect on wake failed:', err);
      });
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [wasEverAuthed, wsService]);
}
