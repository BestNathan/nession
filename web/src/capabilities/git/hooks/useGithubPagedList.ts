import { useCallback, useEffect, useRef, useState } from 'react';
import { asGithubError, type GithubError } from '../githubTypes';
import type { GithubRequestTarget } from './useGithubRequest';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A bounded GitHub list with explicit continuation, refresh and stale-answer
 * guards.
 *
 * `key` is the filter identity: when it changes the list starts over, which is
 * what makes a filter change a new read rather than an append. Search is local
 * to the loaded page and deliberately not in the key — typing must not issue a
 * network request per keystroke.
 */
export function useGithubPagedList<T>({
  agentId,
  sessionId,
  remoteName,
  key,
  enabled = true,
  load,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  remoteName: string | undefined;
  key: string;
  enabled?: boolean;
  load: (target: GithubRequestTarget, cursor: string | null, refresh: boolean) => Promise<Page<T>>;
}) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(enabled && agentId && sessionId));
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<GithubError | null>(null);

  const generation = useRef(0);
  const requestSequence = useRef(0);
  const cursor = useRef<string | null>(null);
  const target = useRef<GithubRequestTarget | null>(null);

  const run = useCallback(
    async (forGeneration: number, forCursor: string | null, refresh: boolean, append: boolean) => {
      const current = target.current;
      if (!current) {
        return;
      }
      const forRequest = ++requestSequence.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const page = await load(current, forCursor, refresh);
        if (generation.current !== forGeneration || requestSequence.current !== forRequest) {
          return;
        }
        setItems((previous) => (append ? [...previous, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        cursor.current = page.nextCursor;
      } catch (failure) {
        if (generation.current !== forGeneration || requestSequence.current !== forRequest) {
          return;
        }
        const typed = asGithubError(failure);
        setError(
          typed ?? {
            code: 'network_unavailable',
            message: failure instanceof Error ? failure.message : 'Could not reach the agent',
          },
        );
      } finally {
        if (generation.current === forGeneration && requestSequence.current === forRequest) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [load],
  );

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    target.current =
      enabled && agentId && sessionId
        ? remoteName
          ? { agent_id: agentId, session: sessionId, remote_name: remoteName }
          : { agent_id: agentId, session: sessionId }
        : null;
    setItems([]);
    setNextCursor(null);
    cursor.current = null;
    setError(null);
    setLoading(Boolean(target.current));
    if (target.current) {
      void run(forGeneration, null, false, false);
    }
  }, [agentId, sessionId, remoteName, key, enabled, run]);

  const refresh = useCallback(() => {
    void run(generation.current, null, true, false);
  }, [run]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !cursor.current) {
      return;
    }
    void run(generation.current, cursor.current, false, true);
  }, [loading, loadingMore, run]);

  return { items, loading, loadingMore, error, hasMore: Boolean(nextCursor), refresh, loadMore };
}
