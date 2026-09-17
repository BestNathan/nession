import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';

interface UseDataFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Generic hook for data fetching with auto-fetch on mount.
 *
 * @param fetcher - The async function to fetch data
 * @param deps - Dependencies array (fetcher will re-run when these change)
 * @returns Object with data, loading, error state, and refetch function
 */
export function useDataFetch<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): UseDataFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcherRef.current();
      setData(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fetch failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
