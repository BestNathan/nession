import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { FileContentViewer } from '@/shared/file-viewer';
import { CodeMirrorEditor } from '@/platform/editor';
import { formatBytes } from '../state';
import type { GitFilePreview, GitPreviewResponse } from '../types';
import type { GitMediaView } from '../hooks/useGitSelection';

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
    case 'too_large':
      return preview.message ?? 'This file is too large for a bounded media preview.';
    case 'ready':
      return preview.binary ? 'Binary file — no text preview.' : null;
    default:
      return null;
  }
}

function PreviewBody({
  path,
  response,
  loading,
  error,
  preview,
  media,
  message,
  isText,
}: {
  path: string;
  response: GitPreviewResponse | null;
  loading: boolean;
  error: string | null;
  preview: GitFilePreview | null;
  media: GitMediaView | null;
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
      {preview.binary && preview.size > 0 && !media ? (
        <p data-testid="git-file-preview-size" className={cn('px-4 pb-2 text-muted-foreground', chromeSansRole('metadata'))}>
          {formatBytes(preview.size)}
        </p>
      ) : null}
      {media ? (
        <div data-testid="git-file-preview-media" className="min-h-0 flex-1">
          <FileContentViewer
            file={{ path }}
            sourceEditor={CodeMirrorEditor}
            data={{
              kind: 'media',
              url: media.url,
              mimeType: media.mimeType,
              complete: true,
            }}
          />
        </div>
      ) : null}
      {isText ? (
        <div data-testid="git-file-preview-text" className="min-h-0 flex-1">
          <FileContentViewer
            file={{ path }}
            sourceEditor={CodeMirrorEditor}
            data={{
              kind: 'text',
              text: preview.text,
              // A truncated answer must not offer a complete structured
              // preview; the shared viewer falls back to source and says so.
              complete: !preview.truncated,
            }}
            readOnly
          />
        </div>
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
 * Read-only worktree content for an untracked or conflicted Git row (#2838,
 * #2876).
 *
 * This is deliberately not a diff renderer. An untracked file has no Git
 * baseline, and an unmerged file's current bytes are the thing a reader needs
 * before resolving it — presenting either as a diff would invent a comparison
 * the repository does not have. The selected row supplies the mode; the Agent
 * rechecks that mode and only returns bytes for the matching status.
 *
 * The presentation is the shared `FileContentViewer`: code uses the same
 * read-only CodeMirror, structured text the same Preview/Raw leaves, and
 * authorized media the same image/video/audio/PDF viewers as Files. Git keeps
 * the path header, its status label and the bounded-read messages.
 */
export function GitFilePreviewView({
  path,
  expected,
  response,
  media,
  loading,
  error,
}: {
  path: string | null;
  expected: PreviewKind;
  response: GitPreviewResponse | null;
  media: GitMediaView | null;
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
  const mediaView = preview?.state === 'ready' ? media : null;
  const message = preview && !mediaView ? stateMessage(preview) : null;
  const isText = preview?.state === 'ready' && !preview.binary && mediaView === null;

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
          path={path}
          response={response}
          loading={loading}
          error={error}
          preview={preview}
          media={mediaView}
          message={message}
          isText={isText}
        />
      </div>
    </div>
  );
}
