import { useCallback, useEffect, useState } from 'react';
import { imagesApi, type ImageDescriptor, type ImagePage } from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';

export interface ImagesPageState {
  images: ImageDescriptor[];
  total: number;
  offset: number;
  limit: number;
  query: string;
  loading: boolean;
  error: string | null;
  hasPrevious: boolean;
  hasNext: boolean;
  setQuery: (value: string) => void;
  next: () => void;
  previous: () => void;
  refresh: () => void;
}

/**
 * One complete-inventory page owned by the Server registry.
 *
 * The caller renders the capability's own surface; this hook owns only paging,
 * search and the truth of a failed read. It deliberately has no selector,
 * Project reference or Sandbox composition semantics.
 */
export function useImagesPage(limit = IMAGE_PAGE_SIZE): ImagesPageState {
  const [offset, setOffset] = useState(0);
  const [query, setQueryState] = useState('');
  const [page, setPage] = useState<ImagePage>({ images: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void imagesApi
      .listImages({ offset, limit, query })
      .then((next) => {
        if (cancelled) {
          return;
        }
        setPage(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setPage({ images: [], total: 0 });
        setError(cause instanceof Error ? cause.message : 'Images could not be loaded');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [limit, offset, query, revision]);

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
    setRevision((current) => current + 1);
  }, []);

  return {
    images: page.images,
    total: page.total,
    offset,
    limit,
    query,
    loading,
    error,
    hasPrevious: offset > 0,
    hasNext: page.next_offset !== null && page.next_offset !== undefined,
    setQuery,
    next,
    previous,
    refresh,
  };
}
