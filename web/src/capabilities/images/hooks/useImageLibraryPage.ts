import { useCallback, useEffect, useState } from 'react';
import {
  imagesApi,
  type ImageLibraryEntry,
  type ImageLibraryPage,
} from '../ImagesPlugin';
import { IMAGE_PAGE_SIZE } from '../model';

export interface ImageLibraryPageState {
  entries: ImageLibraryEntry[];
  total: number;
  offset: number;
  limit: number;
  query: string;
  repository: string;
  loading: boolean;
  error: string | null;
  hasPrevious: boolean;
  hasNext: boolean;
  setQuery: (value: string) => void;
  setRepository: (value: string) => void;
  next: () => void;
  previous: () => void;
  refresh: () => void;
}

/**
 * One Server Catalog Library page (#3799).
 *
 * The Server owns the inventory, Tag metadata and known reference impact. The
 * hook deliberately carries no Agent cache state: that observation belongs to
 * the current Session's Distribution view.
 */
export function useImageLibraryPage(limit = IMAGE_PAGE_SIZE): ImageLibraryPageState {
  const [offset, setOffset] = useState(0);
  const [query, setQueryState] = useState('');
  const [repository, setRepositoryState] = useState('');
  const [page, setPage] = useState<ImageLibraryPage>({ entries: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void imagesApi
      .listLibrary({ offset, limit, query, repository })
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
        setPage({ entries: [], total: 0 });
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
  }, [limit, offset, query, repository, revision]);

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
    setRevision((current) => current + 1);
  }, []);

  return {
    entries: page.entries,
    total: page.total,
    offset,
    limit,
    query,
    repository,
    loading,
    error,
    hasPrevious: offset > 0,
    hasNext: page.next_offset !== null && page.next_offset !== undefined,
    setQuery,
    setRepository,
    next,
    previous,
    refresh,
  };
}
