import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatBytes } from '../state';
import type { GitDiffResponse } from '../types';
import { GitPatchDiff } from './GitPatchDiff';
import { inspectGitPatch, type GitDiffLayout } from './patchPresentation';
import { useSplitDiffAvailability } from '../hooks/useSplitDiffAvailability';

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
 *
 * Pierre draws the patch; this component remains the owner of the answer. The
 * path, the truncation warning and the binary/mode/empty/malformed states are
 * decided here so the renderer cannot present an incomplete or unparseable
 * patch as an ordinary one.
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
  const [layout, setLayout] = useState<GitDiffLayout>('unified');
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const splitAvailable = useSplitDiffAvailability(viewport);

  const diff = response?.state === 'ok' ? response.diff : null;
  const inspection = useMemo(
    () => (diff ? inspectGitPatch(diff.text, diff.binary) : null),
    [diff],
  );

  // A pane that lost the room for two columns is drawn unified. Leaving a
  // split choice selected while its control disappeared would leave no way
  // back to the presentation the reader is actually seeing.
  useEffect(() => {
    if (!splitAvailable) {
      setLayout('unified');
    }
  }, [splitAvailable]);

  if (loading) {
    return (
      <p data-testid="git-diff-loading" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Loading diff…
      </p>
    );
  }
  if (error) {
    return (
      <p data-testid="git-diff-error" role="alert" className={cn('p-4 text-destructive', chromeSansRole('body'))}>
        {error}
      </p>
    );
  }
  if (!response) {
    return (
      <p data-testid="git-diff-empty" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Select a changed file to see what changed in it.
      </p>
    );
  }
  if (response.state !== 'ok') {
    return (
      <p data-testid="git-diff-unavailable" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        {response.message ?? 'This file’s diff is not available.'}
      </p>
    );
  }

  if (!diff || !inspection) {
    return null;
  }

  return (
    <div data-testid="git-diff" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <p
            data-testid="git-diff-path"
            className={cn('truncate', chromeMonoRole('code'))}
            title={diff.path}
          >
            {diff.path}
          </p>
          {diff.truncated ? (
            <p data-testid="git-diff-truncated" className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
              Diff truncated: {formatBytes(diff.truncated_bytes)} left out of a large change.
            </p>
          ) : null}
        </div>
        {inspection.kind === 'renderable' && splitAvailable ? (
          <ToggleGroup
            data-testid="git-diff-layout"
            aria-label="Diff layout"
            value={[layout]}
            onValueChange={(values) => {
              setLayout(values[0] === 'split' ? 'split' : 'unified');
            }}
            size="sm"
            className="shrink-0"
          >
            <ToggleGroupItem
              data-testid="git-diff-layout-unified"
              value="unified"
            >
              Unified
            </ToggleGroupItem>
            <ToggleGroupItem
              data-testid="git-diff-layout-split"
              value="split"
            >
              Split
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </div>
      <div
        ref={setViewport}
        data-testid="git-diff-body"
        data-renderer={inspection.kind}
        className={cn('min-h-0 flex-1 overflow-auto', workspaceScrollClearanceClass)}
      >
        <GitPatchDiff
          diff={diff}
          inspection={inspection}
          layout={splitAvailable ? layout : 'unified'}
        />
      </div>
    </div>
  );
}
