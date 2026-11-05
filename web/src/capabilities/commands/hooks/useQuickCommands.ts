import { useCallback, useEffect, useRef, useState } from 'react';
import { commandsApi } from '@/capabilities/commands/CommandsPlugin';
import type { QuickCommandItem } from '@/capabilities/commands/types';

export type QuickCommandsStatus = 'loading' | 'ready' | 'error';

export interface UseQuickCommandsResult {
  /** The server's list, in the server's order. Never re-sorted here. */
  commands: readonly QuickCommandItem[];
  status: QuickCommandsStatus;
  /**
   * Whether the server link can answer `list`/`changed` right now. `false`
   * means Run must not pretend it can execute; Insert is local text editing.
   */
  connected: boolean;
  /** Retry after a failed list (the view offers it as an explicit action). */
  refresh: () => void;
}

/**
 * The Commands view's read of the saved-command owner (#2710 SC-05).
 *
 * Reads `server.commands.list`, refetches on `server.commands.changed` and on
 * reconnect, and reports the three states the view must distinguish: loading,
 * ready, and unavailable. It deliberately exposes no add/update/delete — the
 * view the requirement draws has Insert and Run, and this hook does not own a
 * second command registry to keep in sync.
 */
export function useQuickCommands(): UseQuickCommandsResult {
  const [commands, setCommands] = useState<readonly QuickCommandItem[]>([]);
  const [status, setStatus] = useState<QuickCommandsStatus>('loading');
  const [connected, setConnected] = useState(
    () => commandsApi.connectionState() === 'connected',
  );
  /** Whether the last observed link state was connected (reconnect detection). */
  const connectedRef = useRef(commandsApi.connectionState() === 'connected');
  /** Ignore a response that belongs to a superseded request. */
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setStatus((previous) => (previous === 'ready' ? previous : 'loading'));
    void commandsApi.listCommands().then(
      (next) => {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setCommands(next);
        setStatus('ready');
      },
      () => {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setStatus('error');
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const unsubChanged = commandsApi.onCommandsChanged(refresh);
    const unsubState = commandsApi.onConnectionStateChange((state) => {
      const wasConnected = connectedRef.current;
      connectedRef.current = state === 'connected';
      setConnected(state === 'connected');
      // A subscription that reports the state the mount-time fetch already saw
      // is not a reconnect; refetching there would double every initial load.
      if (state === 'connected' && !wasConnected) {
        refresh();
      }
    });
    return () => {
      unsubChanged();
      unsubState();
      // A response from this mount must not settle the next one.
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return { commands, status, connected, refresh };
}
