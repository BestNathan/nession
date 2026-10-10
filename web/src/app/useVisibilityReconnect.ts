import { useEffect, useRef } from 'react';
import type { WebSocketService } from '../platform/socket';
import { WIRE as SERVER_INFO_WIRE } from '@/generated/protocol/core/server-info/v1';
import { sessionRuntimeRegistry } from '@/platform/session-runtime/SessionRuntimeRegistry';

const FOREGROUND_PROBE_TIMEOUT_MS = 3_500;

/**
 * Browser lifecycle is a resume signal, not evidence of a lost socket (#1213).
 * Probe the current authenticated Server transport; reuse it if healthy,
 * replace it if stale. P2P sessions use the same Runtime's existing liveness
 * and loss paths. Hidden timers are never needed to start foreground recovery.
 */
export function useVisibilityReconnect(
  wasEverAuthed: boolean,
  wsService: WebSocketService | null,
): void {
  const wasBackgrounded = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const handleBackground = () => {
      wasBackgrounded.current = true;
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        handleBackground();
        return;
      }
      if (!wasBackgrounded.current || !wasEverAuthed || !wsService) { return; }
      wasBackgrounded.current = false;

      // Runtime is the lifecycle authority for each Session. The App only
      // delivers the foreground signal, never mirrors its attach phases.
      sessionRuntimeRegistry.resumeForeground();
      if (inFlight.current) { return; }
      inFlight.current = true;

      const resume = async () => {
        if (wsService.connectionState !== 'connected') {
          await wsService.reconnectNow();
          return;
        }

        // An OPEN WebSocket is not proof of a live peer. server.info is an
        // existing read-only typed round-trip (not a business-list fetch).
        const generation = wsService.physicalGeneration;
        try {
          await wsService.request(SERVER_INFO_WIRE, {}, { timeoutMs: FOREGROUND_PROBE_TIMEOUT_MS });
        } catch {
          // A delayed timeout from socket N must not tear down N+1.
          if (wsService.physicalGeneration !== generation || wsService.connectionState !== 'connected') {
            return;
          }
          wsService.reportUnresponsive(generation);
          await wsService.reconnectNow();
        }
      };

      void resume().catch((error) => {
        console.warn('[visibility] Foreground resume pending:', error);
      }).finally(() => {
        inFlight.current = false;
      });
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handleBackground);
    window.addEventListener('pageshow', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handleBackground);
      window.removeEventListener('pageshow', handleVisibility);
    };
  }, [wasEverAuthed, wsService]);
}
