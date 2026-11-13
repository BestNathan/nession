import { useCallback, useEffect, useState } from 'react';
import { gitApi } from '../GitPlugin';
import type { GitCommit, GitLogResponse } from '../types';

export function useGitHistoryPagination(
  history: GitLogResponse | null | undefined,
  agentId: string | undefined,
  sessionId: string | undefined,
) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [endOfHistory, setEndOfHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (history?.state === 'ok') {
      setCommits(history.history.commits);
      setNextCursor(history.history.next_cursor ?? null);
      setEndOfHistory(history.history.end_of_history);
    }
  }, [history]);

  const loadOlder = useCallback(async () => {
    if (!agentId || !sessionId || !nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await gitApi.gitLog({ agent_id: agentId, session: sessionId, before: nextCursor });
      if (page.state === 'ok') {
        setCommits((prev) => [...prev, ...page.history.commits]);
        setNextCursor(page.history.next_cursor ?? null);
        setEndOfHistory(page.history.end_of_history);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, sessionId, nextCursor, loadingMore]);

  return { commits, nextCursor, endOfHistory, loadingMore, loadOlder };
}
