import { cn } from '@/shared/lib/utils';
import { classifyDiffLine, formatBytes } from '../state';
import type { GitDiffResponse } from '../types';

const LINE_CLASS: Record<ReturnType<typeof classifyDiffLine>, string> = {
  // The same vocabulary `EnvDiff` uses for a changed line, so "an added line"
  // reads identically wherever Nession draws one.
  added: 'bg-file-created/10 text-file-created',
  removed: 'bg-file-deleted/10 text-file-deleted',
  meta: 'text-muted-foreground',
  context: '',
};

/**
 * One file's diff against HEAD.
 *
 * `text` is already capped by the agent, and `truncated_bytes` says how much it
 * dropped. #750 C3 is explicit that a truncated diff must say so — a half diff
 * presented as a whole one invites the reader to conclude the rest is unchanged,
 * which is the one wrong conclusion available.
 *
 * `truncated_bytes` is snake_case and every sibling field on this wire is
 * camelCase; that is the contract's doing, not a typo here. `FileDiff` is the
 * one git type with no `rename_all`, so its key is the Rust field name. The
 * generated type is what keeps this line honest — before it, the hand-written
 * mirror said `truncatedBytes`, which is `undefined` on every real answer.
 */
export function GitDiffView({
  response,
  loading,
  error,
}: {
  response: GitDiffResponse | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <p data-testid="git-diff-loading" className="p-4 text-sm text-muted-foreground">
        Loading diff…
      </p>
    );
  }
  if (error) {
    return (
      <p data-testid="git-diff-error" role="alert" className="p-4 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!response) {
    return (
      <p data-testid="git-diff-empty" className="p-4 text-sm text-muted-foreground">
        Select a changed file to see what changed in it.
      </p>
    );
  }
  if (response.state !== 'ok') {
    return (
      <p data-testid="git-diff-unavailable" className="p-4 text-sm text-muted-foreground">
        {response.message ?? 'This file’s diff is not available.'}
      </p>
    );
  }

  const { diff } = response;
  return (
    <div data-testid="git-diff" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 py-2">
        <p className="truncate text-sm font-medium" title={diff.path}>
          {diff.path}
        </p>
        {diff.binary ? (
          <p className="text-xs text-muted-foreground">Binary file — no line diff to show</p>
        ) : null}
        {diff.truncated ? (
          <p data-testid="git-diff-truncated" className="text-xs text-muted-foreground">
            Diff truncated: {formatBytes(diff.truncated_bytes)} left out of a large change.
          </p>
        ) : null}
      </div>
      <pre
        data-testid="git-diff-body"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap py-2 font-mono text-xs"
      >
        {diff.text === '' ? (
          <span className="block px-4 text-muted-foreground">
            No changes to show for this file.
          </span>
        ) : (
          diff.text.split('\n').map((line, index) => (
            <span
              // Unified-diff lines carry no identity of their own — two context
              // lines can be byte-identical, so position is what distinguishes
              // them and the line is rendered as static text, never reordered.
              key={index}
              className={cn('block px-4', LINE_CLASS[classifyDiffLine(line)])}
            >
              {line === '' ? ' ' : line}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}
