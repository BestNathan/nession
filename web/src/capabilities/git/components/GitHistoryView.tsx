import { useCallback, useState } from 'react';
import { gitApi } from '../GitPlugin';
import { useGitHistory } from '../hooks/useGitHistory';
import { useGitHistoryPagination } from '../hooks/useGitHistoryPagination';
import { useGitCommitDetail } from '../hooks/useGitCommitDetail';
import { useGitRequest } from '../hooks/useGitRequest';
import { describeUnavailable } from '../state';
import { GitNotice } from './GitNotice';
import { GitDiffView } from './GitDiffView';
import { GitHistoryCommitDetail } from './GitHistoryCommitDetail';
import { GitHistoryCommitList } from './GitHistoryCommitList';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';

export function GitHistoryView({ ctx }: { ctx: WorkspaceContext }) {
  const agentId = ctx.agent?.agent_id;
  const sessionId = ctx.session?.session_id;
  const { history, loading, error, refresh } = useGitHistory({ agentId, sessionId });
  const { commits, nextCursor, endOfHistory, loadingMore, loadOlder } = useGitHistoryPagination(
    history,
    agentId,
    sessionId,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const { detail, loading: detailLoading, error: detailError } = useGitCommitDetail({
    agentId,
    sessionId,
    oid: selected,
  });

  const loadDiff = useCallback(
    (target: { agent_id: string; session: string }) => {
      if (!selected || !selectedFile) {
        throw new Error('no selection');
      }
      return gitApi.gitDiff({ ...target, path: selectedFile, commit: selected });
    },
    [selected, selectedFile],
  );

  const {
    data: diffResponse,
    loading: diffLoading,
    error: diffError,
  } = useGitRequest({
    agentId: selected && selectedFile ? agentId : undefined,
    sessionId: selected && selectedFile ? sessionId : undefined,
    load: loadDiff,
  });

  const onSelectCommit = useCallback((hash: string) => {
    setSelected(hash);
    setSelectedFile(null);
  }, []);

  if (loading) {
    return <GitNotice testId="git-history-loading">Reading history…</GitNotice>;
  }
  if (error) {
    return (
      <GitNotice testId="git-history-error" destructive>
        {error}
      </GitNotice>
    );
  }
  if (!history || history.state !== 'ok') {
    if (!history) {
      return <GitNotice testId="git-history-empty">No history yet.</GitNotice>;
    }
    return (
      <div
        data-testid="git-history-unavailable"
        data-state={history.state}
        className="flex h-full min-h-0 items-center justify-center px-6 text-center"
      >
        <p className="max-w-sm text-sm text-muted-foreground">
          {describeUnavailable(history).title}
        </p>
      </div>
    );
  }

  const { limit, truncated, truncatedBytes } = history.history;
  if (commits.length === 0) {
    return (
      <GitNotice testId="git-history-none">
        This repository has no commits yet.
      </GitNotice>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]">
      <GitHistoryCommitList
        commits={commits}
        limit={limit}
        truncated={truncated}
        truncatedBytes={truncatedBytes}
        selected={selected}
        endOfHistory={endOfHistory}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        onSelect={onSelectCommit}
        onLoadOlder={() => {
          void loadOlder();
        }}
        onRefresh={() => refresh()}
      />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-none">
        <GitHistoryCommitDetail
          oid={selected}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
        />
        {selectedFile ? (
          <div className="min-h-0 flex-1 overflow-y-auto border-t">
            <GitDiffView response={diffResponse} loading={diffLoading} error={diffError} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
