import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/shared/markdown';
import { cn } from '@/shared/lib/utils';
import {
  chromeLabelRole,
  chromeMonoRole,
  chromeSansRole,
} from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import type { MemoryState } from '../hooks/useMemory';
import { resolveMemoryLink, type MemoryLinkResolution } from '../model/memoryLink';
import { useMemoryFragmentScroll } from '../hooks/useMemoryFragmentScroll';
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
                    'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
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
            onOpenFile={onOpenFile}
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

/**
 * The reading surface for one Memory file (#2742).
 *
 * It owns the two pieces the shared renderer must not know: which Markdown
 * links are Memory navigation, and when a fragment can safely scroll (after the
 * target document has rendered). Every transition is keyed by the path and the
 * snapshot directory, so a pending fragment from an earlier file cannot fire
 * into a later one.
 */
function MemoryReader({
  memory,
  onOpenFile,
  onLoadMore,
  onRetryRead,
}: {
  memory: MemoryState;
  onOpenFile: (path: string) => void;
  onLoadMore: () => void;
  onRetryRead: () => void;
}) {
  const [mode, setMode] = useState<'preview' | 'raw'>('preview');
  const contentRef = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);
  const selectedPath = memory.selectedPath;
  const directory = memory.response?.memory_directory ?? '';
  const { setPending, notice, setNotice, beginLinkNavigation } = useMemoryFragmentScroll(
    memory,
    contentRef,
    mode === 'preview',
  );

  // A different document context resets the raw/preview choice.
  useEffect(() => {
    setMode('preview');
  }, [directory]);

  const navigate = useCallback(
    (path: string, fragment: string | null) => {
      setMode('preview');
      setNotice(null);
      if (fragment === null) {
        setPending(null);
      } else {
        beginLinkNavigation(path, selectedPath);
        setPending({ path, fragment, nonce: (nonce.current += 1) });
      }
      if (path !== selectedPath) {
        void onOpenFile(path);
      }
    },
    [beginLinkNavigation, onOpenFile, selectedPath, setPending, setNotice],
  );

  const handleLink = useCallback(
    (href: string | undefined): boolean => {
      if (!selectedPath) {
        return true;
      }
      const resolution = resolveMemoryLink(href, selectedPath, memory.files);
      if (resolution.kind === 'external') {
        return false;
      }
      if (resolution.kind === 'fragment') {
        navigate(selectedPath, resolution.fragment);
        return true;
      }
      if (resolution.kind === 'file') {
        navigate(resolution.path, resolution.fragment);
        return true;
      }
      setMode('preview');
      setPending(null);
      setNotice(blockedMessage(resolution));
      return true;
    },
    [memory.files, navigate, selectedPath, setPending, setNotice],
  );

  const file = memory.files.find((candidate) => candidate.path === selectedPath);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <MemoryDocumentHeader
        memory={memory}
        fileSize={memory.totalSize || file?.size || 0}
        contentType={memory.contentType || file?.content_type || 'markdown'}
        mode={mode}
        onModeChange={setMode}
        onLoadMore={onLoadMore}
      />
      <MemoryDocument
        memory={memory}
        mode={mode}
        notice={notice}
        contentRef={contentRef}
        onLink={handleLink}
        onRetryRead={onRetryRead}
      />
    </div>
  );
}

function MemoryDocumentHeader({
  memory,
  fileSize,
  contentType,
  mode,
  onModeChange,
  onLoadMore,
}: {
  memory: MemoryState;
  fileSize: number;
  contentType: string;
  mode: 'preview' | 'raw';
  onModeChange: (mode: 'preview' | 'raw') => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <div className="min-w-0">
        <p className={cn('truncate', chromeMonoRole('code'))} title={memory.selectedPath ?? undefined}>
          {memory.selectedPath}
        </p>
        <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          {contentType} · {formatSize(fileSize)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Memory display mode" className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === 'preview' ? 'default' : 'outline'}
            aria-pressed={mode === 'preview'}
            data-testid="claude-code-memory-mode-preview"
            onClick={() => onModeChange('preview')}
          >
            Preview
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'raw' ? 'default' : 'outline'}
            aria-pressed={mode === 'raw'}
            data-testid="claude-code-memory-mode-raw"
            onClick={() => onModeChange('raw')}
          >
            Raw
          </Button>
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
    </div>
  );
}

function MemoryDocument({
  memory,
  mode,
  notice,
  contentRef,
  onLink,
  onRetryRead,
}: {
  memory: MemoryState;
  mode: 'preview' | 'raw';
  notice: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  onLink: (href: string | undefined) => boolean;
  onRetryRead: () => void;
}) {
  return (
    <div
      ref={contentRef}
      data-testid="claude-code-memory-content"
      className={cn('min-h-0 flex-1 overflow-y-auto py-4', workspaceScrollClearanceClass)}
    >
      {notice ? (
        <p
          role="status"
          data-testid="claude-code-memory-link-notice"
          className={cn('mb-3 text-muted-foreground', chromeSansRole('secondary'))}
        >
          {notice}
        </p>
      ) : null}
      {memory.hasMore ? (
        <p
          data-testid="claude-code-memory-partial"
          className={cn('mb-3 text-muted-foreground', chromeSansRole('metadata'))}
        >
          Partial content — this file is not fully loaded. Use Load more to continue.
        </p>
      ) : null}
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
      {mode === 'raw' ? (
        <pre
          data-testid="claude-code-memory-raw"
          className={cn('whitespace-pre-wrap', chromeMonoRole('code'))}
        >
          {memory.content || (memory.readLoading ? '' : '(empty)')}
        </pre>
      ) : memory.content ? (
        <Markdown variant="document" onLink={onLink} className="pb-4">
          {memory.content}
        </Markdown>
      ) : memory.readLoading ? null : (
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>(empty)</p>
      )}
    </div>
  );
}

type BlockedLink = Extract<MemoryLinkResolution, { kind: 'blocked' }>;

function blockedMessage(resolution: BlockedLink): string {
  switch (resolution.reason) {
    case 'unlisted':
    case 'unsupported-target':
      return `“${resolution.target}” is not a Markdown file in this Memory snapshot.`;
    case 'traversal':
      return 'That link tries to leave the Memory directory and was not opened.';
    case 'absolute-path':
      return 'That link points outside the Memory directory and was not opened.';
    case 'unsafe-scheme':
      return 'That link uses an unsupported or unsafe scheme and was not opened.';
    case 'query':
      return 'That link is not a Memory file path.';
    default:
      return 'That link is not a valid Memory path.';
  }
}

function MemoryContent({
  memory,
  onOpenFile,
  onLoadMore,
  onRetryRead,
}: {
  memory: MemoryState;
  onOpenFile: (path: string) => void;
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
  return (
    <MemoryReader
      memory={memory}
      onOpenFile={onOpenFile}
      onLoadMore={onLoadMore}
      onRetryRead={onRetryRead}
    />
  );
}
