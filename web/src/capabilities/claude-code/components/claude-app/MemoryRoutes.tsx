import { RefreshButton } from '@/components/ui/RefreshButton';
import { MemoryView } from '../MemoryView';
import type { ClaudeAppData } from './model';

/** This Session's project memory, as a file list. */
export function MemoryRoute({ data }: { data: ClaudeAppData }) {
  const memory = data.state.memory;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-memory">
      {/* #4602: resting manual refresh of the memory directory. */}
      <div className="flex shrink-0 justify-end border-b px-[var(--nession-shell-space-4)] py-[var(--nession-shell-space-2)]">
        <RefreshButton
          onClick={() => memory.retry()}
          variant="ghost"
          ariaLabel="Refresh Claude Code memory"
        />
      </div>
      <MemoryView
        memory={memory.memory}
        layout="push"
        pane="list"
        onOpenFile={(path) => {
          void memory.openFile(path);
          data.actions.push({ kind: 'memory-file' });
        }}
        onLoadMore={() => memory.loadMore()}
        onRetry={() => memory.retry()}
        onRetryRead={() => {
          const path = memory.memory.selectedPath;
          if (path) {
            void memory.openFile(path);
          }
        }}
      />
    </div>
  );
}

/**
 * One memory file, at its own pushed depth.
 *
 * Internal Markdown links keep this depth: they are navigation *within* the
 * memory directory, so replacing the open path is the disclosure rather than a
 * second page stacked on the first.
 */
export function MemoryFileRoute({ data }: { data: ClaudeAppData }) {
  const memory = data.state.memory;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-memory-file">
      <MemoryView
        memory={memory.memory}
        layout="push"
        pane="detail"
        onOpenFile={(path) => void memory.openFile(path)}
        onLoadMore={() => memory.loadMore()}
        onRetry={() => memory.retry()}
        onRetryRead={() => {
          const path = memory.memory.selectedPath;
          if (path) {
            void memory.openFile(path);
          }
        }}
      />
    </div>
  );
}
