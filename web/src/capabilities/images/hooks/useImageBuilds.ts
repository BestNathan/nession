import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  imagesApi,
  type ImageBuildDescriptor,
  type ImageBuildSourceKind,
  type ImageBuildStatus,
} from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';

export interface ImageBuildsState {
  builds: ImageBuildDescriptor[];
  total: number;
  offset: number;
  limit: number;
  statuses: ImageBuildStatus[];
  sources: ImageBuildSourceKind[];
  query: string;
  loading: boolean;
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

/** Reads one authoritative page and applies pushed transitions to it. */
function useBuildPage(selection: BuildPageSelection) {
  const { limit, offset, setOffset, statuses, sources, query } = selection;
  const [builds, setBuilds] = useState<ImageBuildDescriptor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const previousState = useRef(imagesApi.connectionState());
  const pageState = useRef({ builds, total, offset, statuses, sources, query, limit });
  const statusKey = useMemo(() => [...statuses].sort().join(','), [statuses]);
  const sourceKey = useMemo(() => [...sources].sort().join(','), [sources]);

  useEffect(() => {
    pageState.current = { builds, total, offset, statuses, sources, query, limit };
  }, [builds, total, offset, statuses, sources, query, limit]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void imagesApi
      .listBuilds({ offset, limit, statuses, sources, query })
      .then((page) => {
        if (cancelled) {
          return;
        }
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
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setBuilds([]);
        setTotal(0);
        setError(cause instanceof Error ? cause.message : 'Image builds could not be loaded');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [limit, offset, query, revision, setOffset, sourceKey, sources, statusKey, statuses]);

  useEffect(
    () =>
      imagesApi.onBuildChanged((build) => {
        const page = pageState.current;
        const index = page.builds.findIndex(
          (candidate) => candidate.build_id === build.build_id,
        );
        if (index >= 0) {
          const next = [...page.builds];
          next[index] = build;
          setBuilds(next);
          return;
        }
        // A build entering this filtered page is only added when the page
        // starts at the newest record; otherwise the page is re-read.
        if (
          page.offset === 0
          && buildMatches(build, page.statuses, page.sources, page.query)
        ) {
          setBuilds([build, ...page.builds].slice(0, page.limit));
          setTotal(page.total + 1);
        }
      }),
    [],
  );

  useEffect(
    () =>
      imagesApi.onConnectionStateChange((state) => {
        // A new physical connection may have missed pushes: the durable
        // inventory is authoritative and is re-read once it is back.
        if (previousState.current !== 'connected' && state === 'connected') {
          setRevision((current) => current + 1);
        }
        previousState.current = state;
      }),
    [],
  );

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
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

  return { builds, total, loading, error, refresh, applyRecord };
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
