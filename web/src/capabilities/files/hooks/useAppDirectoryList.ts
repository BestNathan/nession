import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileOps, FileEntry } from '@/capabilities/files';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface AppDirectoryListOptions {
  fileOps: FileOps;
  path: string;
  /** Increment to re-fetch the current directory (#1140 folder sheet). */
  reloadSignal?: number;
  onEntriesChange?: (entries: FileEntry[]) => void;
}

export interface AppDirectoryListState {
  /** `null` until the current directory's first answer (the skeleton state). */
  entries: FileEntry[] | null;
  error: string | null;
  refreshing: boolean;
  stale: boolean;
  /** Re-read the current directory after a failed load (the error Retry). */
  retry: () => void;
}

/** A visible mutable list on the ordinary cadence (#4602 §2). */
const APP_DIRECTORY_POLICY: PullRefreshPolicy = {
  intervalMs: 30_000,
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * The App Files view's directory read (#1140), extracted from `FileList`'s
 * inline effect onto the shared pull controller (#4602).
 *
 * Path and the reload signals are the read context: navigating into another
 * directory — or asking for a re-read — retires the previous read before any
 * new answer publishes, so a late parent listing cannot overwrite the current
 * directory. A background refresh keeps the rows on screen; a failure keeps the
 * last known rows marked stale, and only a failure with no answer yet surfaces
 * the error panel.
 *
 * #3451: counts are optional metadata — this reads one directory and never
 * enumerates child directories solely to populate a subtitle.
 */
export function useAppDirectoryList({
  fileOps,
  path,
  reloadSignal = 0,
  onEntriesChange,
}: AppDirectoryListOptions): AppDirectoryListState {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const onEntriesChangeRef = useRef(onEntriesChange);
  onEntriesChangeRef.current = onEntriesChange;

  const apply = useCallback((listed: FileEntry[]) => {
    setEntries(listed);
    onEntriesChangeRef.current?.(listed);
  }, []);

  const { status } = usePullRefresh<FileEntry[]>({
    context: ['app-directory', path, reloadToken, reloadSignal],
    pull: () => fileOps.listDir(path).then(({ entries: listed }) => listed),
    apply,
    policy: APP_DIRECTORY_POLICY,
    label: 'app-directory',
  });

  // A different directory (or an explicit re-read) is a different listing: the
  // previous rows leave the screen so the skeleton, not stale rows, shows while
  // the new read is in flight.
  useEffect(() => {
    setEntries(null);
  }, [path, reloadToken, reloadSignal]);

  const retry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return {
    entries,
    error: status.error,
    refreshing: status.refreshing,
    stale: status.stale,
    retry,
  };
}