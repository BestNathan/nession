import { useCallback, useEffect, useRef, useState } from 'react';
import { gitApi } from '../GitPlugin';
import type { GitLogResponse } from '../types';

export interface GitHistoryState {
  history: GitLogResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

const INITIAL: GitHistoryState = { history: null, loading: true, error: null };

/**
 * Recent commits for a Session's repository.
 *
 * Pulled when the caller asks, like `useGitStatus` — and pulled *only* when the
 * caller asks, which is why this is a hook the History section calls rather than
 * something the Git view loads on open. Someone opening Git to read a diff
 * should not pay for a log they never look at, and the agent should not run one.
 *
 * `limit` is passed through as a request; the agent clamps it. Nothing here
 * assumes the answer has that many commits.
 */
export function useGitHistory({
  agentId,
  sessionId,
  enabled,
  limit,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  /** False until the section is actually shown. */
  enabled: boolean;
  limit?: number;
}): GitHistoryState & { refresh: () => void } {
  const [state, setState] = useState<GitHistoryState>(INITIAL);

  const generation = useRef(0);
  const target = useRef<{ agent_id: string; session: string } | null>(null);

  const load = useCallback(
    async (forGeneration: number) => {
      const current = target.current;
      if (!current) {
        return;
      }
      setState((previous) => ({ ...previous, loading: true, error: null }));
      try {
        const response = await gitApi.gitLog({ ...current, ...(limit ? { limit } : {}) });
        if (generation.current !== forGeneration) {
          return;
        }
        setState({ history: response, loading: false, error: null });
      } catch (error) {
        if (generation.current !== forGeneration) {
          return;
        }
        setState({
          history: null,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not reach the agent',
        });
      }
    },
    [limit],
  );

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    target.current = agentId && sessionId ? { agent_id: agentId, session: sessionId } : null;
    if (!target.current || !enabled) {
      // Dormant until asked for: the section's own effect starts the first load,
      // so switching Sessions while History is closed costs nothing.
      setState({ ...INITIAL, loading: false });
      return;
    }
    void load(forGeneration);
  }, [load, agentId, sessionId, enabled]);

  const refresh = useCallback(() => {
    void load(generation.current);
  }, [load]);

  return { ...state, refresh };
}
