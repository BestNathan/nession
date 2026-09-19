import { useCallback } from 'react';
import { gitApi } from '../GitPlugin';
import { useGitRequest } from './useGitRequest';
import type { GitWorktreesResponse } from '../types';

export interface GitWorktreesState {
  worktrees: GitWorktreesResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

/**
 * The repository's worktrees for a Session (#846).
 *
 * No `limit`: a worktree is a directory someone made by hand, so the count is
 * small in a way a branch count is not. The agent still caps the bytes.
 */
export function useGitWorktrees({
  agentId,
  sessionId,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
}): GitWorktreesState & { refresh: () => void } {
  const load = useCallback(
    (target: { agent_id: string; session: string }) => gitApi.gitWorktrees(target),
    [],
  );
  const { data, loading, error, refresh } = useGitRequest({ agentId, sessionId, load });

  return { worktrees: data, loading, error, refresh };
}
