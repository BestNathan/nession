import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { formatBytes } from '../state';
import type { GitFilePreview, GitPreviewResponse } from '../types';

type PreviewKind = 'untracked' | 'unmerged';

function statusLabel(kind: PreviewKind): string {
  return kind === 'untracked'
    ? 'Untracked · File preview (no Git baseline)'
    : 'Unresolved conflict · File preview';
}

function stateMessage(preview: GitFilePreview): string | null {
  switch (preview.state) {
    case 'missing':
      return 'This file is no longer present in the worktree.';
    case 'denied':
      return preview.message ?? 'The Agent could not read this file.';
    case 'changed':
      return preview.message ?? 'The file changed since it was selected. Refresh Git Changes.';
    case 'unsupported':
      return preview.message ?? 'This entry cannot be previewed as a regular file.';
    case 'ready':
      return preview.binary ? 'Binary file — no text preview.' : null;
    default:
      return null;
  }
}

function PreviewBody({
  response,
  loading,
  error,
  preview,
  message,
  isText,
}: {
  response: GitPreviewResponse | null;
  loading: boolean;
  error: string | null;
  preview: GitFilePreview | null;
  message: string | null;
  isText: boolean;
}) {
  if (loading) {
    return (
      <p data-testid="git-file-preview-loading" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Reading file…
      </p>
    );
  }
  if (error) {
    return (
      <p data-testid="git-file-preview-error" role="alert" className={cn('p-4 text-destructive', chromeSansRole('body'))}>
        {error}
      </p>
    );
  }
  if (response && response.state !== 'ok') {
    return (
      <p data-testid="git-file-preview-unavailable" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        {response.message ?? 'This file’s preview is not available.'}
      </p>
    );
  }
  if (!preview) {
    return (
      <p data-testid="git-file-preview-no-selection" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Select a changed file to read it.
      </p>
    );
  }

  return (
    <>
      {message ? (
        <p data-testid="git-file-preview-message" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
          {message}
        </p>
      ) : null}
      {preview.binary && preview.size > 0 ? (
        <p data-testid="git-file-preview-size" className={cn('px-4 pb-2 text-muted-foreground', chromeSansRole('metadata'))}>
          {formatBytes(preview.size)}
        </p>
      ) : null}
      {isText && preview.text !== '' ? (
        <pre
          data-testid="git-file-preview-text"
          className={cn('whitespace-pre p-4 font-mono', chromeMonoRole('code'))}
        >
          {preview.text}
        </pre>
      ) : null}
      {preview.state === 'ready' && !preview.binary && preview.text === '' ? (
        <p data-testid="git-file-preview-empty-file" className={cn('px-4 pb-4 text-muted-foreground', chromeSansRole('metadata'))}>
          No content in this file.
        </p>
      ) : null}
    </>
  );
}

/**
 * Read-only worktree bytes for an untracked or conflicted Git row (#2838).
 *
 * This is deliberately not a diff renderer. An untracked file has no Git
 * baseline, and an unmerged file's current bytes are the thing a reader needs
 * before resolving it — presenting either as a diff would invent a comparison
 * the repository does not have. The selected row supplies the mode; the Agent
 * rechecks that mode and only returns bytes for the matching status.
 *
 * The path header is rendered while the read is in flight and after a failure,
 * so the selected resource never disappears from view while its state changes.
 */
export function GitFilePreviewView({
  path,
  expected,
  response,
  loading,
  error,
}: {
  path: string | null;
  expected: PreviewKind;
  response: GitPreviewResponse | null;
  loading: boolean;
  error: string | null;
}) {
  if (!path) {
    return (
      <p data-testid="git-file-preview-empty" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Select a changed file to read it.
      </p>
    );
  }

  const preview = response?.state === 'ok' ? response.preview : null;
  const message = preview ? stateMessage(preview) : null;
  const isText = preview?.state === 'ready' && !preview.binary;

  return (
    <div data-testid="git-file-preview" data-state={preview?.state ?? (loading ? 'loading' : 'unavailable')} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 py-2">
        <p
          data-testid="git-file-preview-path"
          className={cn('truncate', chromeMonoRole('code'))}
          title={path}
        >
          {path}
        </p>
        <p data-testid="git-file-preview-status" className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          {statusLabel(expected)}
        </p>
        {preview?.truncated ? (
          <p data-testid="git-file-preview-truncated" className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            Preview truncated: {formatBytes(preview.truncated_bytes)} left out of a large file.
          </p>
        ) : null}
      </div>
      <div
        data-testid="git-file-preview-body"
        className={cn('min-h-0 flex-1 overflow-auto', workspaceScrollClearanceClass)}
      >
        <PreviewBody
          response={response}
          loading={loading}
          error={error}
          preview={preview}
          message={message}
          isText={isText}
        />
      </div>
    </div>
  );
}
