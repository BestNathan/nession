import { useCallback, useState } from 'react';
import {
  imagesApi,
  type ImageLibraryEntry,
  type ImageLibraryPage,
} from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface ImageLibraryPageState {
  entries: ImageLibraryEntry[];
  total: number;
  offset: number;
  limit: number;
  query: string;
  repository: string;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  hasPrevious: boolean;
  hasNext: boolean;
  setQuery: (value: string) => void;
  setRepository: (value: string) => void;
  next: () => void;
  previous: () => void;
  refresh: () => void;
}

/** Images are catalog state, not live work: the slow cadence (#4602 §2). */
const IMAGE_LIBRARY_POLICY: PullRefreshPolicy = {
  intervalMs: 60_000,
  minIntervalMs: 5_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * One Server Catalog Library page (#3799).
 *
 * The Server owns the inventory, Tag metadata and known reference impact. The
 * hook deliberately carries no Agent cache state: that observation belongs to
 * the current Session's Distribution view.
 *
 * Page, query and repository are the read context (#4602): changing one retires
 * the previous read so an older page can never overwrite a newer one. A
 * background refresh keeps the current page, filter and scroll — it does not
 * reset pagination, and a failure keeps the last known page marked stale.
 */
export function useImageLibraryPage(limit = IMAGE_PAGE_SIZE): ImageLibraryPageState {
  const [offset, setOffset] = useState(0);
  const [query, setQueryState] = useState('');
  const [repository, setRepositoryState] = useState('');
  const [page, setPage] = useState<ImageLibraryPage>({ entries: [], total: 0 });

  const apply = useCallback((next: ImageLibraryPage) => {
    setPage(next);
    // An authoritative count can move a page out of range (a tag removed the
    // last entry). Clamp to the last real page rather than showing an empty one.
    if (next.entries.length === 0 && next.total > 0 && offset > 0) {
      setOffset(Math.max(0, Math.floor((next.total - 1) / limit) * limit));
    }
  }, [offset, limit]);

  const { refresh: pull, status } = usePullRefresh<ImageLibraryPage>({
    context: ['image-library', offset, limit, query, repository],
    pull: () => imagesApi.listLibrary({ offset, limit, query, repository }),
    apply,
    policy: IMAGE_LIBRARY_POLICY,
    label: 'image-library',
  });

  const setQuery = useCallback((value: string) => {
    setOffset(0);
    setQueryState(value);
  }, []);
  const setRepository = useCallback((value: string) => {
    setOffset(0);
    setRepositoryState(value);
  }, []);
  const next = useCallback(() => {
    setOffset((current) => current + limit);
  }, [limit]);
  const previous = useCallback(() => {
    setOffset((current) => Math.max(0, current - limit));
  }, [limit]);
  const refresh = useCallback(() => {
    void pull('manual');
  }, [pull]);

  return {
    entries: page.entries,
    total: page.total,
    offset,
    limit,
    query,
    repository,
    loading: status.loading,
    refreshing: status.refreshing,
    stale: status.stale,
    error: status.error,
    hasPrevious: offset > 0,
    hasNext: page.next_offset !== null && page.next_offset !== undefined,
    setQuery,
    setRepository,
    next,
    previous,
    refresh,
  };
}