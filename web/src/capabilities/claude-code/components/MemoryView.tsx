import { FileText, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import {
  chromeLabelRole,
  chromeMonoRole,
  chromeSansRole,
} from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import type { MemoryState } from '../hooks/useMemory';
import { formatSize } from '../format';

/**
 * The current Session's Claude Code Auto Memory (#2689).
 *
 * A read-only sibling of the Configuration view inside the same capability: the
 * repository was resolved from the Session before this rendered, so there is no
 * project picker and no machine-wide inventory here. The disclosure line is
 * deliberate — the user can see which repository and which effective memory
 * directory the answer came from, rather than trusting an opaque list.
 *
 * Every provider state has its own sentence. `unavailable`, `no_memory`,
 * `disabled`, `unsupported_override` and `error` are different facts, and
 * rendering any of them as an empty file list would claim something the
 * provider did not say.
 */
export function MemoryView({
  memory,
  onOpenFile,
  onLoadMore,
  onRetry,
  onRetryRead,
}: {
  memory: MemoryState;
  onOpenFile: (path: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRetryRead: () => void;
}) {
  const response = memory.response;

  if (memory.loading) {
    return (
      <div data-testid="claude-code-memory" className="p-4">
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          Loading this Session's Claude Code memory...
        </p>
      </div>
    );
  }

  if (memory.error) {
    return (
      <div data-testid="claude-code-memory" className="space-y-3 p-4">
        <p className={cn('text-destructive', chromeSansRole('body'))} role="alert">
          {memory.error}
        </p>
        <Button data-testid="claude-code-memory-retry" variant="outline" size="sm" onClick={() => onRetry()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!response) {
    return (
      <div data-testid="claude-code-memory" className="p-4">
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
          Loading this Session's Claude Code memory...
        </p>
      </div>
    );
  }

  if (response.state !== 'ready') {
    return (
      <div data-testid="claude-code-memory" className="p-4" data-state={response.state}>
        <MemoryNotice response={response} />
        {response.state === 'error' ? (
          <Button
            data-testid="claude-code-memory-retry"
            className="mt-3"
            variant="outline"
            size="sm"
            onClick={() => onRetry()}
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <MemoryReady
      memory={memory}
      response={response}
      onOpenFile={onOpenFile}
      onLoadMore={onLoadMore}
      onRetryRead={onRetryRead}
    />
  );
}

function MemoryReady({
  memory,
  response,
  onOpenFile,
  onLoadMore,
  onRetryRead,
}: {
  memory: MemoryState;
  response: NonNullable<MemoryState['response']>;
  onOpenFile: (path: string) => void;
  onLoadMore: () => void;
  onRetryRead: () => void;
}) {
  return (
    <div data-testid="claude-code-memory" className="flex min-h-0 flex-1 flex-col" data-state="ready">
      <div className="shrink-0 border-b px-4 py-2">
        <p className={chromeLabelRole()}>Auto Memory</p>
        <p
          className={cn('truncate text-muted-foreground', chromeMonoRole('code'))}
          title={response.memory_directory ?? undefined}
          data-testid="claude-code-memory-source"
        >
          {response.repository_root}
          {response.repository_kind === 'project_root' ? ' (not a Git repository)' : ''}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
        <aside
          className={cn(
            'max-h-48 shrink-0 overflow-y-auto border-b p-2 md:max-h-none md:min-h-0 md:border-b-0 md:border-r',
            workspaceScrollClearanceClass,
          )}
          data-testid="claude-code-memory-list"
        >
          {memory.files.length === 0 ? (
            <p className={cn('p-2 text-muted-foreground', chromeSansRole('secondary'))}>
              This memory directory has no Markdown files yet.
            </p>
          ) : (
            <div className="space-y-0.5">
              {memory.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  aria-label={file.path}
                  aria-current={memory.selectedPath === file.path ? 'true' : undefined}
                  onClick={() => onOpenFile(file.path)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
                    chromeSansRole('secondary'),
                    'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    memory.selectedPath === file.path && 'bg-accent text-accent-foreground',
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{file.path}</span>
                </button>
              ))}
            </div>
          )}
          {response.truncated ? (
            <p className={cn('p-2 text-muted-foreground', chromeSansRole('metadata'))}>
              More files exist than this view lists.
            </p>
          ) : null}
        </aside>
        <main className="flex min-h-0 flex-col">
          <MemoryContent
            memory={memory}
            onLoadMore={onLoadMore}
            onRetryRead={onRetryRead}
          />
        </main>
      </div>
    </div>
  );
}

function MemoryNotice({
  response,
}: {
  response: NonNullable<MemoryState['response']>;
}) {
  const { state, error } = response;
  const sentence =
    state === 'unavailable'
      ? "This Session's working directory is not available, so its Claude Code memory cannot be resolved."
      : state === 'no_memory'
        ? 'This repository has no Claude Code Auto Memory yet.'
        : state === 'disabled'
          ? 'Auto Memory is turned off in this repository\'s Claude Code settings.'
          : state === 'unsupported_override'
            ? "Claude Code's memory location is configured in a way Nession cannot verify."
            : 'Claude Code memory could not be read.';
  return (
    <div className="space-y-1">
      <p className={cn('text-muted-foreground', chromeSansRole('body'))}>{sentence}</p>
      {response.repository_root ? (
        <p
          className={cn('text-muted-foreground', chromeMonoRole('code'))}
          title={response.memory_directory ?? undefined}
          data-testid="claude-code-memory-source"
        >
          {response.repository_root}
          {response.repository_kind === 'project_root' ? ' (not a Git repository)' : ''}
        </p>
      ) : null}
      {error ? (
        <p className={cn('text-muted-foreground', chromeMonoRole('code'))}>{error}</p>
      ) : null}
    </div>
  );
}

function MemoryContent({
  memory,
  onLoadMore,
  onRetryRead,
}: {
  memory: MemoryState;
  onLoadMore: () => void;
  onRetryRead: () => void;
}) {
  if (!memory.selectedPath) {
    return (
      <p className={cn('p-6 text-muted-foreground', chromeSansRole('secondary'))}>
        Select a memory file to read it.
      </p>
    );
  }

  const file = memory.files.find((candidate) => candidate.path === memory.selectedPath);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <p className={cn('truncate', chromeMonoRole('code'))} title={memory.selectedPath}>
            {memory.selectedPath}
          </p>
          <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            {memory.contentType || file?.content_type || 'markdown'} ·{' '}
            {formatSize(memory.totalSize || file?.size || 0)}
          </p>
        </div>
        {memory.hasMore ? (
          <Button
            data-testid="claude-code-memory-load-more"
            variant="outline"
            size="sm"
            disabled={memory.readLoading}
            onClick={() => onLoadMore()}
          >
            Load more
          </Button>
        ) : null}
      </div>
      {memory.readLoading ? (
        <p className={cn('py-3 text-muted-foreground', chromeSansRole('secondary'))}>
          Loading memory...
        </p>
      ) : null}
      {memory.readError ? (
        <div className="flex items-center gap-3 py-3">
          <p className={cn('text-destructive', chromeSansRole('body'))} role="alert">
            {memory.readError}
          </p>
          <Button
            data-testid="claude-code-memory-read-retry"
            variant="outline"
            size="sm"
            onClick={() => onRetryRead()}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      ) : null}
      <pre
        data-testid="claude-code-memory-content"
        className={cn(
          'min-h-0 flex-1 overflow-auto whitespace-pre-wrap py-4',
          chromeMonoRole('code'),
          workspaceScrollClearanceClass,
        )}
      >
        {memory.content || (memory.readLoading ? '' : '(empty)')}
      </pre>
    </div>
  );
}
