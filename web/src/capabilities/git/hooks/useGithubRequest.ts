import { useCallback, useEffect, useRef, useState } from 'react';
import { githubErrorOf, type GithubError } from '../githubTypes';

type OkResponse<T> = Exclude<T, { state: 'error' }>;

export interface GithubRequestTarget {
  agent_id: string;
  session: string;
  remote_name?: string;
}

interface GithubResponseLike {
  state: 'ok' | 'error';
}

/**
 * One GitHub read, pulled when its target changes and on explicit refresh.
 *
 * The sibling of `useGitRequest`, with the same two guards: a generation for
 * the Session/remote changing, and a per-started-read sequence so a manual
 * Refresh cannot be overwritten by an older in-flight answer. It adds one
 * thing GitHub needs — a typed provider error is stored instead of being
 * flattened to a string, so the view can say "not authenticated" or "rate
 * limited" rather than "request failed".
 */
export function useGithubRequest<T extends GithubResponseLike>({
  agentId,
  sessionId,
  remoteName,
  enabled = true,
  load,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  remoteName?: string;
  enabled?: boolean;
  load: (target: GithubRequestTarget, refresh: boolean) => Promise<T>;
}) {
  const [data, setData] = useState<OkResponse<T> | null>(null);
  const [loading, setLoading] = useState(Boolean(enabled && agentId && sessionId));
  const [error, setError] = useState<GithubError | null>(null);

  const generation = useRef(0);
  const requestSequence = useRef(0);
  const target = useRef<GithubRequestTarget | null>(null);

  const run = useCallback(
    async (forGeneration: number, refresh: boolean) => {
      const current = target.current;
      if (!current) {
        return;
      }
      const forRequest = ++requestSequence.current;
      setLoading(true);
      setError(null);
      let nextData: OkResponse<T> | null = null;
      let nextError: GithubError | null = null;
      try {
        const response = await load(current, refresh);
        nextError = githubErrorOf(response);
        nextData = nextError ? null : (response as OkResponse<T>);
      } catch (failure) {
        nextError = {
          code: 'network_unavailable',
          message: failure instanceof Error ? failure.message : 'Could not reach the agent',
        };
      }
      if (generation.current !== forGeneration || requestSequence.current !== forRequest) {
        return;
      }
      setData(nextData);
      setError(nextError);
      setLoading(false);
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
    setData(null);
    setError(null);
    setLoading(Boolean(target.current));
    if (target.current) {
      void run(forGeneration, false);
    }
  }, [agentId, sessionId, remoteName, enabled, run]);

  const refresh = useCallback(() => {
    if (target.current) {
      void run(generation.current, true);
    }
  }, [run]);

  return { data, loading, error, refresh };
}
