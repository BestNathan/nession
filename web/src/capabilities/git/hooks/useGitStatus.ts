import { useCallback, useEffect, useRef, useState } from 'react';
import { gitApi } from '../GitPlugin';
import type { GitStatusResponse } from '../types';

export interface GitStatusState {
  status: GitStatusResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

const INITIAL: GitStatusState = { status: null, loading: true, error: null };

/**
 * Repository state for a Session, pulled when the Session changes and when the
 * caller asks.
 *
 * Pull-on-open plus an explicit refresh, never a poll — the model #750's Open
 * Question 3 settled on and the one `claude_code.list` already used. The
 * repository is resolved agent-side from the Session's live working directory
 * each time, so a `cd` inside the Session is picked up by the next request
 * rather than needing to be pushed.
 *
 * Shared rather than written twice: the Workspace view and the Terminal
 * projection show the same repository, and two loaders would be two chances to
 * disagree about it.
 */
export function useGitStatus({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}): GitStatusState & { refresh: () => void } {
  const [state, setState] = useState<GitStatusState>(INITIAL);

  // Bumped whenever the Session changes; a response that arrives after the
  // context moved on is dropped rather than written over the new one.
  const generation = useRef(0);
  const target = useRef<{ agent_id: string; session: string } | null>(null);

  const load = useCallback(async (forGeneration: number) => {
    const current = target.current;
    if (!current) {
      return;
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await gitApi.gitStatus(current);
      if (generation.current !== forGeneration) {
        return;
      }
      setState({ status: response, loading: false, error: null });
    } catch (error) {
      if (generation.current !== forGeneration) {
        return;
      }
      setState({
        status: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Could not reach the agent',
      });
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    const forGeneration = generation.current;
    target.current = agentId && sessionId ? { agent_id: agentId, session: sessionId } : null;
    setState({ ...INITIAL, loading: Boolean(target.current) });
    if (target.current) {
      void load(forGeneration);
    }
    // The two ids are the dependencies, not a `target` object rebuilt on every
    // render: identity would re-run this effect without anything having changed.
  }, [load, agentId, sessionId]);

  const refresh = useCallback(() => {
    void load(generation.current);
  }, [load]);

  return { ...state, refresh };
}
