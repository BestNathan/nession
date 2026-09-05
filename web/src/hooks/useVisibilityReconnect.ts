import { useEffect } from 'react';
import type { WebSocketService } from '../services/socket';

/**
 * When the tab becomes visible after being backgrounded (e.g. mobile app
 * switch), check whether the WebSocket died while we were away and trigger
 * an immediate reconnect instead of waiting for the backoff timer — which
 * the browser may have throttled or paused during suspension.
 *
 * Only a stopped transport ('disconnected') is re-armed here: 'connecting' has
 * an in-flight attempt (connect() is shared), 'reconnecting' already has a
 * timer scheduled, and 'connected' needs nothing.
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
      if (wsService.connectionState !== 'disconnected') { return; }

      console.log('[visibility] Tab became visible — reconnecting WebSocket');
      wsService.connect().catch((err) => {
        console.error('[visibility] Reconnect on wake failed:', err);
      });
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [wasEverAuthed, wsService]);
}
