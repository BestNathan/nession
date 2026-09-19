import { useCallback } from 'react';
import { gitApi } from '../GitPlugin';
import { useGitRequest } from './useGitRequest';
import type { GitBranchesResponse } from '../types';

export interface GitBranchesState {
  branches: GitBranchesResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

/**
 * Local branches for a Session's repository (#846).
 *
 * Mounted by the Branches section rather than loaded by the Git view on open, on
 * the same terms as History: a reader who came for a diff never makes the agent
 * enumerate refs.
 */
export function useGitBranches({
  agentId,
  sessionId,
  limit,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  limit?: number;
}): GitBranchesState & { refresh: () => void } {
  const load = useCallback(
    (target: { agent_id: string; session: string }) =>
      gitApi.gitBranches({ ...target, ...(limit ? { limit } : {}) }),
    [limit],
  );
  const { data, loading, error, refresh } = useGitRequest({ agentId, sessionId, load });

  return { branches: data, loading, error, refresh };
}
