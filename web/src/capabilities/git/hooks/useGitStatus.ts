import { useCallback } from 'react';
import { gitApi } from '../GitPlugin';
import { useGitRequest } from './useGitRequest';
import type { GitStatusResponse } from '../types';

export interface GitStatusState {
  status: GitStatusResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

/**
 * Repository state for a Session, pulled when the Session changes and when the
 * caller asks.
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
  const load = useCallback(
    (target: { agent_id: string; session: string }) => gitApi.gitStatus(target),
    [],
  );
  const { data, loading, error, refresh } = useGitRequest({ agentId, sessionId, load });

  return { status: data, loading, error, refresh };
}
