import { useCallback, useState } from 'react';
import { imagesApi, type ImageDescriptor, type ImagePage } from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface ImagesPageState {
  images: ImageDescriptor[];
  total: number;
  offset: number;
  limit: number;
  query: string;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  hasPrevious: boolean;
  hasNext: boolean;
  setQuery: (value: string) => void;
  next: () => void;
  previous: () => void;
  refresh: () => void;
}

/** Images are catalog state, not live work: the slow cadence (#4602 §2). */
const IMAGES_POLICY: PullRefreshPolicy = {
  intervalMs: 60_000,
  minIntervalMs: 5_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * One complete-inventory page owned by the Server registry.
 *
 * The caller renders the capability's own surface; this hook owns only paging,
 * search and the truth of a failed read. It deliberately has no selector,
 * Project reference or Sandbox composition semantics.
 *
 * Page, query and limit are the read context (#4602): changing one retires the
 * previous read so an older page can never overwrite a newer one. A background
 * refresh keeps the current page and filter — it does not reset pagination —
 * and a failure keeps the last known page marked stale rather than clearing it.
 */
export function useImagesPage(limit = IMAGE_PAGE_SIZE): ImagesPageState {
  const [offset, setOffset] = useState(0);
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState<ImagePage>({ images: [], total: 0 });

  const apply = useCallback((next: ImagePage) => {
    setPage(next);
    // An authoritative count can move a page out of range (a removed image).
    // Clamp to the last real page rather than showing an empty one.
    if (next.images.length === 0 && next.total > 0 && offset > 0) {
      setOffset(Math.max(0, Math.floor((next.total - 1) / limit) * limit));
    }
  }, [offset, limit]);

  const { refresh: pull, status } = usePullRefresh<ImagePage>({
    context: ['server-images', offset, limit, query],
    pull: () => imagesApi.listImages({ offset, limit, query }),
    apply,
    policy: IMAGES_POLICY,
    label: 'server-images',
  });

  const setQuery = useCallback((value: string) => {
    setOffset(0);
    setQueryState(value);
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

  // Before the first answer the page is loading, not authoritatively empty.
  const noAnswerYet = status.lastSuccessAt === null && status.error === null;
  return {
    images: page.images,
    total: page.total,
    offset,
    limit,
    query,
    loading: status.loading || noAnswerYet,
    refreshing: status.refreshing,
    stale: status.stale,
    error: status.error,
    hasPrevious: offset > 0,
    hasNext: page.next_offset !== null && page.next_offset !== undefined,
    setQuery,
    next,
    previous,
    refresh,
  };
}