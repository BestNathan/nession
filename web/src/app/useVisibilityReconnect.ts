import { useEffect, useRef } from 'react';
import type { WebSocketService } from '../platform/socket';
import { WIRE as SERVER_INFO_WIRE } from '@/generated/protocol/core/server-info/v1';
import { sessionRuntimeRegistry } from '@/platform/session-runtime/SessionRuntimeRegistry';

const FOREGROUND_PROBE_TIMEOUT_MS = 3_500;
/**
 * Cadence of the application-level Server liveness probe while the page is
 * visible and connected (#3358 SC-03).
 *
 * Low frequency on purpose: this is not a keepalive, and the Server already
 * sends WebSocket pings. It exists because a half-open socket fires no close
 * event, and browser lifecycle events cannot cover a page that stays visible.
 */
const SERVER_LIVENESS_INTERVAL_MS = 30_000;
const SERVER_LIVENESS_TIMEOUT_MS = 5_000;

/**
 * Browser lifecycle is a resume signal, not evidence of a lost socket (#1213).
 * Probe the current authenticated Server transport; reuse it if healthy,
 * replace it if stale. P2P sessions use the same Runtime's existing liveness
 * and loss paths. Hidden timers are never needed to start foreground recovery.
 *
 * A page that stays visible gets the same bounded probe on a low-frequency
 * interval (#3358 SC-03): an OPEN socket whose peer went silent is otherwise
 * invisible until the user leaves and returns.
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

  // Half-open coverage for a page that never fires a lifecycle signal. Same
  // read-only round trip, same generation fence, one probe at a time across
  // both background/foreground and interval paths.
  useEffect(() => {
    if (!wasEverAuthed || !wsService) {
      return;
    }
    const probe = async (): Promise<void> => {
      if (document.visibilityState !== 'visible'
        || wsService.connectionState !== 'connected'
        || inFlight.current) {
        return;
      }
      inFlight.current = true;
      const generation = wsService.physicalGeneration;
      try {
        await wsService.request(SERVER_INFO_WIRE, {}, { timeoutMs: SERVER_LIVENESS_TIMEOUT_MS });
      } catch {
        // A delayed timeout from socket N must not tear down N+1.
        if (wsService.physicalGeneration !== generation
          || wsService.connectionState !== 'connected') {
          return;
        }
        wsService.reportUnresponsive(generation);
        await wsService.reconnectNow().catch(() => {});
      } finally {
        inFlight.current = false;
      }
    };
    const timer = setInterval(() => {
      void probe();
    }, SERVER_LIVENESS_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [wasEverAuthed, wsService]);
}
