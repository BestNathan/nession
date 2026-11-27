import { useCallback, useEffect, useRef } from 'react';
import type { WebSocketService } from '@/platform/socket';
import { useRefreshRuntime } from '@/platform/refresh';
import { useVisibilityReconnect } from './useVisibilityReconnect';

/**
 * Turns the app's existing lifecycle facts into refresh signals (#4602 §2).
 *
 * Two facts only, both already established elsewhere:
 *
 * - **reconnect** — the authenticated transport came back on a *new* physical
 *   generation. The first socket is not a reconnect; every surface's mount read
 *   already covers it, and emitting here would double the initial read.
 * - **foreground** — the page returned and the existing liveness probe proved
 *   the peer live. A resume that had to reconnect reports through the
 *   connection instead, and the bus suppresses the duplicate.
 *
 * This hook owns no probe of its own: `useVisibilityReconnect` remains the one
 * owner of foreground recovery and half-open detection.
 */
export function useRefreshSignals(
  wasEverAuthed: boolean,
  wsService: WebSocketService | null,
): void {
  const { signals } = useRefreshRuntime();
  const seenGeneration = useRef<number | null>(null);

  useEffect(() => {
    if (!wsService) {
      seenGeneration.current = null;
      return;
    }
    seenGeneration.current = wsService.connectionState === 'connected'
      ? wsService.physicalGeneration
      : null;
    return wsService.onConnectionStateChange((state) => {
      if (state !== 'connected') { return; }
      const generation = wsService.physicalGeneration;
      if (seenGeneration.current === generation) { return; }
      seenGeneration.current = generation;
      signals.emit({ signal: 'reconnect', generation });
    });
  }, [wsService, signals]);

  const handleForegroundReady = useCallback(() => {
    if (!wsService || wsService.connectionState !== 'connected') { return; }
    signals.emit({ signal: 'foreground', generation: wsService.physicalGeneration });
  }, [wsService, signals]);

  useVisibilityReconnect(wasEverAuthed, wsService, handleForegroundReady);
}