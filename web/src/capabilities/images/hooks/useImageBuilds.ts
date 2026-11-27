import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  imagesApi,
  type ImageBuildDescriptor,
  type ImageBuildSourceKind,
  type ImageBuildStatus,
} from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface ImageBuildsState {
  builds: ImageBuildDescriptor[];
  total: number;
  offset: number;
  limit: number;
  statuses: ImageBuildStatus[];
  sources: ImageBuildSourceKind[];
  query: string;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  actionError: string | null;
  hasPrevious: boolean;
  hasNext: boolean;
  refresh: () => void;
  setQuery: (value: string) => void;
  toggleStatus: (status: ImageBuildStatus) => void;
  toggleSource: (source: ImageBuildSourceKind) => void;
  previous: () => void;
  next: () => void;
  clearActionError: () => void;
  cancel: (buildId: string, attempt: number) => Promise<void>;
  retry: (buildId: string, attempt: number) => Promise<void>;
}

function sourceText(build: ImageBuildDescriptor): string {
  const source = build.source;
  switch (source.kind) {
    case 'github':
      return `${source.repository_url} ${source.ref}`;
    case 'local_directory':
      return source.path;
    case 'compose':
      return source.sources
        .map((entry) => `${entry.repository} ${entry.ref}`)
        .join(' ');
  }
}

/** The same bounded substring filter the Server applies (#3798). */
export function imageBuildMatchesQuery(
  build: ImageBuildDescriptor,
  query: string,
): boolean {
  const needle = query.trim();
  if (needle.length === 0) {
    return true;
  }
  return (
    build.build_id.includes(needle)
    || build.image_id.includes(needle)
    || (build.alias ?? '').includes(needle)
    || (build.digest ?? '').includes(needle)
    || sourceText(build).includes(needle)
  );
}

function buildMatches(
  build: ImageBuildDescriptor,
  statuses: readonly ImageBuildStatus[],
  sources: readonly ImageBuildSourceKind[],
  query: string,
): boolean {
  if (statuses.length > 0 && !statuses.includes(build.status)) {
    return false;
  }
  if (sources.length > 0 && !sources.includes(build.source.kind)) {
    return false;
  }
  return imageBuildMatchesQuery(build, query);
}

/** Search/filter state plus its offset; changing a filter starts a new page. */
function useBuildFilterSelection(limit: number) {
  const [offset, setOffset] = useState(0);
  const [statuses, setStatuses] = useState<ImageBuildStatus[]>([]);
  const [sources, setSources] = useState<ImageBuildSourceKind[]>([]);
  const [query, setQueryState] = useState('');
  const setQuery = useCallback((value: string) => {
    setOffset(0);
    setQueryState(value);
  }, []);
  const toggleStatus = useCallback((status: ImageBuildStatus) => {
    setOffset(0);
    setStatuses((current) =>
      current.includes(status)
        ? current.filter((candidate) => candidate !== status)
        : [...current, status],
    );
  }, []);
  const toggleSource = useCallback((source: ImageBuildSourceKind) => {
    setOffset(0);
    setSources((current) =>
      current.includes(source)
        ? current.filter((candidate) => candidate !== source)
        : [...current, source],
    );
  }, []);
  const previous = useCallback(() => {
    setOffset((current) => Math.max(0, current - limit));
  }, [limit]);
  const next = useCallback(() => {
    setOffset((current) => current + limit);
  }, [limit]);
  return {
    offset,
    setOffset,
    statuses,
    sources,
    query,
    setQuery,
    toggleStatus,
    toggleSource,
    previous,
    next,
  };
}

/** One authoritative page selection and its transition target. */
interface BuildPageSelection {
  limit: number;
  offset: number;
  setOffset: (offset: number) => void;
  statuses: ImageBuildStatus[];
  sources: ImageBuildSourceKind[];
  query: string;
}

/** Running builds are live work: the fast cadence (#4602 §2). */
const BUILDS_POLICY: PullRefreshPolicy = {
  intervalMs: 12_000,
  minIntervalMs: 2_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

interface BuildPageAnswer {
  builds: ImageBuildDescriptor[];
  total: number;
}

/**
 * Reads one authoritative page and applies pushed transitions to it.
 *
 * The page's filter selection is the read context (#4602): an older query's
 * reply can no longer land on a newer selection. A push is applied to a record
 * only while that record still belongs to the filtered page — a transition that
 * moves it out of the filter, or a new build that belongs in it, re-reads the
 * authoritative page instead of patching the list and guessing a total.
 */
function useBuildPage(selection: BuildPageSelection) {
  const { limit, offset, setOffset, statuses, sources, query } = selection;
  const [builds, setBuilds] = useState<ImageBuildDescriptor[]>([]);
  const [total, setTotal] = useState(0);
  const statusKey = useMemo(() => [...statuses].sort().join(','), [statuses]);
  const sourceKey = useMemo(() => [...sources].sort().join(','), [sources]);

  // Assigned during render, not in an effect: a push arriving between a filter
  // change and its effect must already see the new selection.
  const pageState = useRef({ builds, total, offset, statuses, sources, query, limit });
  pageState.current = { builds, total, offset, statuses, sources, query, limit };

  const apply = useCallback((page: BuildPageAnswer) => {
    // A page whose records expired under the current offset falls back to
    // the last page that still exists instead of claiming the history is
    // empty.
    if (page.builds.length === 0 && page.total > 0 && offset > 0) {
      const lastStart = Math.floor((page.total - 1) / limit) * limit;
      if (lastStart !== offset) {
        setOffset(lastStart);
        return;
      }
    }
    setBuilds(page.builds);
    setTotal(page.total);
  }, [offset, limit, setOffset]);

  const { refresh: pull, invalidate, status } = usePullRefresh<BuildPageAnswer>({
    context: ['image-builds', offset, limit, statusKey, sourceKey, query],
    pull: () => imagesApi.listBuilds({ offset, limit, statuses, sources, query }),
    apply,
    policy: BUILDS_POLICY,
    label: 'image-builds',
  });

  const invalidateRef = useRef(invalidate);
  invalidateRef.current = invalidate;
  const pullRef = useRef(pull);
  pullRef.current = pull;
  const previousConnection = useRef(imagesApi.connectionState());

  useEffect(
    () =>
      imagesApi.onConnectionStateChange((state) => {
        // A new physical connection may have missed pushes: the durable
        // inventory is authoritative and is re-read once it is back. The read
        // goes through the controller, so it shares the fence and budget and
        // coalesces with a foreground signal from the app composition.
        if (previousConnection.current !== 'connected' && state === 'connected') {
          void pullRef.current('reconnect');
        }
        previousConnection.current = state;
      }),
    [],
  );

  useEffect(
    () =>
      imagesApi.onBuildChanged((build) => {
        const page = pageState.current;
        const matches = buildMatches(build, page.statuses, page.sources, page.query);
        const index = page.builds.findIndex(
          (candidate) => candidate.build_id === build.build_id,
        );
        if (index >= 0) {
          if (!matches) {
            // The transition moved this record out of the active filter. The
            // page's membership and count are the Server's to answer.
            invalidateRef.current('invalidate');
            return;
          }
          const next = [...page.builds];
          next[index] = build;
          setBuilds(next);
          return;
        }
        if (matches) {
          // A build entering this filtered page changes both membership and
          // total. Re-read rather than fabricating a row and a count.
          invalidateRef.current('invalidate');
        }
      }),
    [],
  );

  const refresh = useCallback(() => {
    void pull('manual');
  }, [pull]);

  const applyRecord = useCallback((build: ImageBuildDescriptor) => {
    setBuilds((current) => {
      const index = current.findIndex(
        (candidate) => candidate.build_id === build.build_id,
      );
      if (index < 0) {
        return current;
      }
      const updated = [...current];
      updated[index] = build;
      return updated;
    });
  }, []);

  return {
    builds,
    total,
    loading: status.loading,
    refreshing: status.refreshing,
    stale: status.stale,
    error: status.error,
    refresh,
    applyRecord,
  };
}

/** Cancel/retry bound to the observed attempt; a refusal re-reads the page. */
function useBuildActions(
  applyRecord: (build: ImageBuildDescriptor) => void,
  refresh: () => void,
) {
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = useCallback(
    async (action: () => Promise<ImageBuildDescriptor>) => {
      setActionError(null);
      try {
        applyRecord(await action());
        refresh();
      } catch (cause: unknown) {
        setActionError(
          cause instanceof Error ? cause.message : 'The build action was refused',
        );
        refresh();
      }
    },
    [applyRecord, refresh],
  );
  const cancel = useCallback(
    (buildId: string, attempt: number) =>
      runAction(() => imagesApi.cancelBuild(buildId, attempt)),
    [runAction],
  );
  const retry = useCallback(
    (buildId: string, attempt: number) =>
      runAction(() => imagesApi.retryBuild(buildId, attempt)),
    [runAction],
  );
  const clearActionError = useCallback(() => setActionError(null), []);
  return { actionError, clearActionError, cancel, retry };
}

/**
 * The durable, filtered build history for the Images capability (#3334, #3798).
 *
 * The build directory is the execution authority. This hook reads one Server
 * page for the current search/filter selection, applies pushed transitions to
 * the records it already holds, and re-reads the same page after a reconnect.
 * A pushed record that is not on the current page is not fabricated into it:
 * the authoritative page is re-read instead.
 */
export function useImageBuilds(limit = IMAGE_PAGE_SIZE): ImageBuildsState {
  const filters = useBuildFilterSelection(limit);
  const page = useBuildPage({
    limit,
    offset: filters.offset,
    setOffset: filters.setOffset,
    statuses: filters.statuses,
    sources: filters.sources,
    query: filters.query,
  });
  const actions = useBuildActions(page.applyRecord, page.refresh);
  return {
    builds: page.builds,
    total: page.total,
    offset: filters.offset,
    limit,
    statuses: filters.statuses,
    sources: filters.sources,
    query: filters.query,
    loading: page.loading,
    refreshing: page.refreshing,
    stale: page.stale,
    error: page.error,
    actionError: actions.actionError,
    hasPrevious: filters.offset > 0,
    hasNext: filters.offset + page.builds.length < page.total,
    refresh: page.refresh,
    setQuery: filters.setQuery,
    toggleStatus: filters.toggleStatus,
    toggleSource: filters.toggleSource,
    previous: filters.previous,
    next: filters.next,
    clearActionError: actions.clearActionError,
    cancel: actions.cancel,
    retry: actions.retry,
  };
}
