import { useCallback, useEffect, useRef, useState } from 'react';
import { commandsApi } from '@/capabilities/commands/CommandsPlugin';
import type { QuickCommandItem } from '@/capabilities/commands/types';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

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
  /** A read is in flight or queued for the current scope. */
  refreshing: boolean;
  /** The last known list may be behind the server (a failed refresh). */
  stale: boolean;
  /** Retry after a failed list (the view offers it as an explicit action). */
  refresh: () => void;
}

/** A visible mutable list on the ordinary cadence (#4602 §2). */
const QUICK_COMMANDS_POLICY: PullRefreshPolicy = {
  intervalMs: 30_000,
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * The Commands view's read of the saved-command owner (#2710 SC-05).
 *
 * Reads `server.commands.list`, refetches on `server.commands.changed` and on
 * reconnect, and reports the three states the view must distinguish: loading,
 * ready, and unavailable. It deliberately exposes no add/update/delete — the
 * view the requirement draws has Insert and Run, and this hook does not own a
 * second command registry to keep in sync.
 *
 * The read lifecycle belongs to the shared pull controller (#4602). The
 * `server.commands.changed` push carries no snapshot — it only names a change —
 * so it routes through the controller's `invalidate` seam (one owed trailing
 * read) rather than fabricating an `acceptExternal` answer. The reconnect edge
 * is reported to the controller as a `reconnect` read; the link-state listener
 * is retained because it also owns the `connected` projection the view needs.
 */
export function useQuickCommands(): UseQuickCommandsResult {
  const [commands, setCommands] = useState<readonly QuickCommandItem[]>([]);
  const [connected, setConnected] = useState(
    () => commandsApi.connectionState() === 'connected',
  );
  /** Whether the last observed link state was connected (reconnect detection). */
  const connectedRef = useRef(commandsApi.connectionState() === 'connected');

  const apply = useCallback((next: readonly QuickCommandItem[]) => {
    setCommands(next);
  }, []);

  const { refresh: pull, invalidate, status } = usePullRefresh<readonly QuickCommandItem[]>({
    context: ['quick-commands'],
    pull: () => commandsApi.listCommands(),
    apply,
    policy: QUICK_COMMANDS_POLICY,
    label: 'quick-commands',
  });

  useEffect(() => {
    const unsubChanged = commandsApi.onCommandsChanged(() => {
      invalidate('invalidate');
    });
    const unsubState = commandsApi.onConnectionStateChange((state) => {
      const wasConnected = connectedRef.current;
      connectedRef.current = state === 'connected';
      setConnected(state === 'connected');
      // A subscription that reports the state the mount-time fetch already saw
      // is not a reconnect; refetching there would double every initial load.
      if (state === 'connected' && !wasConnected) {
        void pull('reconnect');
      }
    });
    return () => {
      unsubChanged();
      unsubState();
    };
  }, [invalidate, pull]);

  const refresh = useCallback(() => {
    void pull('manual');
  }, [pull]);

  // A failed background refresh keeps the last known list visible (marked
  // stale); only a failure with no answer yet is the view's error state.
  const hasData = status.lastSuccessAt !== null;
  const statusValue: QuickCommandsStatus = hasData
    ? 'ready'
    : status.error !== null
      ? 'error'
      : 'loading';

  return {
    commands,
    status: statusValue,
    connected,
    refreshing: status.refreshing,
    stale: status.stale,
    refresh,
  };
}