import { useCallback } from 'react';
import { gitApi } from '../GitPlugin';
import { useGitRequest } from './useGitRequest';
import type { GitLogResponse } from '../types';

export interface GitHistoryState {
  history: GitLogResponse | null;
  loading: boolean;
  /** A transport failure — distinct from a state the agent answered with. */
  error: string | null;
}

/**
 * Recent commits for a Session's repository.
 *
 * Mounted by the History section rather than loaded by the Git view on open:
 * mounting *is* the request, so someone opening Git to read a diff pays for no
 * log, and the agent runs none.
 *
 * `limit` is passed through as a request; the agent clamps it. Nothing here
 * assumes the answer has that many commits.
 */
export function useGitHistory({
  agentId,
  sessionId,
  limit,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  limit?: number;
}): GitHistoryState & { refresh: () => void } {
  const load = useCallback(
    (target: { agent_id: string; session: string }) =>
      gitApi.gitLog({ ...target, ...(limit ? { limit } : {}) }),
    [limit],
  );
  const { data, loading, error, refresh } = useGitRequest({ agentId, sessionId, load });

  return { history: data, loading, error, refresh };
}
