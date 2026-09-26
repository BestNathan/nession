import { useCallback } from 'react';
import { gitApi } from '../GitPlugin';
import { useGitRequest } from './useGitRequest';
import type { GitCommitResponse } from '../types';

export function useGitCommitDetail({
  agentId,
  sessionId,
  oid,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  oid: string | null;
}) {
  const load = useCallback(
    (target: { agent_id: string; session: string }) => {
      if (!oid) {
        throw new Error('no commit selected');
      }
      return gitApi.gitCommit({ ...target, oid });
    },
    [oid],
  );

  const enabled = Boolean(agentId && sessionId && oid);
  const { data, loading, error, refresh } = useGitRequest<GitCommitResponse>({
    agentId: enabled ? agentId : undefined,
    sessionId: enabled ? sessionId : undefined,
    load,
  });

  return { detail: data, loading, error, refresh };
}
