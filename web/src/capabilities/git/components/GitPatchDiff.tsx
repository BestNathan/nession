import { useMemo } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { classifyDiffLine } from '../state';
import type { GitFileDiff } from '../types';
import { type GitDiffLayout, type GitPatchInspection } from './patchPresentation';

const LINE_CLASS: Record<ReturnType<typeof classifyDiffLine>, string> = {
  // The same vocabulary `EnvDiff` uses for a changed line, so "an added line"
  // reads identically wherever Nession draws one.
  added: 'bg-file-created/10 text-file-created',
  removed: 'bg-file-deleted/10 text-file-deleted',
  meta: 'text-muted-foreground',
  context: '',
};

/**
 * Nession vocabulary inside Pierre's Shadow DOM.
 *
 * The renderer owns the line grid and token colours, but not the surface it is
 * drawn on: the pane's background, mono face, code size and the diff tints are
 * Nession's. These are custom properties, so they cross the shadow boundary;
 * the `unsafe` layer is the last layer Pierre ships, which is where an adapter
 * is expected to override its defaults. Syntax token colours remain the
 * renderer's own theme — a diff is code, and repainting its tokens would make
 * this one surface disagree with every other code reader in the app.
 */
const NESSION_DIFF_CSS = `
:host {
  --diffs-font-size: var(--nession-typography-code-size);
  --diffs-line-height: calc(var(--nession-typography-code-size) * var(--nession-typography-code-line-height));
  --diffs-light: var(--nession-foreground);
  --diffs-light-bg: var(--nession-background);
  --diffs-light-addition-color: var(--nession-file-created);
  --diffs-light-deletion-color: var(--nession-file-deleted);
  --diffs-bg-context-override: var(--nession-background);
  --diffs-bg-buffer-override: var(--nession-muted);
  --diffs-fg-number-override: var(--nession-muted-foreground);
  --diffs-bg-addition-override: color-mix(in oklab, var(--nession-file-created) 10%, var(--nession-background));
  --diffs-bg-deletion-override: color-mix(in oklab, var(--nession-file-deleted) 10%, var(--nession-background));
  --diffs-gap-block: 0px;
}
pre, code {
  font-family: inherit;
}
`;

/**
 * The bounded patch, drawn by Pierre Diffs.
 *
 * This adapter owns exactly what `PatchDiff` cannot know: which of Nession's
 * diff states the answer is, the Nession surface variables handed across the
 * shadow boundary, and the raw fallback for output the parser rejects. The
 * view above it owns the file identity, truncation disclosure and loading,
 * empty and error states.
 */
export function GitPatchDiff({
  diff,
  inspection,
  layout,
}: {
  diff: GitFileDiff;
  inspection: GitPatchInspection;
  layout: GitDiffLayout;
}) {
  const options = useMemo(
    () => ({
      theme: 'pierre-light',
      themeType: 'light' as const,
      diffStyle: layout,
      disableFileHeader: true,
      overflow: 'scroll' as const,
      preferredHighlighter: 'shiki-js' as const,
      unsafeCSS: NESSION_DIFF_CSS,
    }),
    [layout],
  );

  if (inspection.kind === 'binary') {
    return (
      <p data-testid="git-diff-binary" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        Binary file — no line diff to show
      </p>
    );
  }

  if (inspection.kind === 'empty') {
    return (
      <p data-testid="git-diff-no-changes" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        No changes to show for this file.
      </p>
    );
  }

  if (inspection.kind === 'mode-only') {
    return (
      <p data-testid="git-diff-mode-only" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        File mode changed from{' '}
        <code className={chromeMonoRole('code')}>{inspection.from}</code> to{' '}
        <code className={chromeMonoRole('code')}>{inspection.to}</code>. No line changes.
      </p>
    );
  }

  if (inspection.kind === 'no-lines') {
    return (
      <p data-testid="git-diff-no-lines" className={cn('p-4 text-muted-foreground', chromeSansRole('secondary'))}>
        No line changes to show for this file.
      </p>
    );
  }

  if (inspection.kind === 'malformed') {
    return (
      <div data-testid="git-diff-fallback" className="space-y-2 p-4">
        <p data-testid="git-diff-fallback-note" className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
          Could not render this diff. Showing the raw patch.
        </p>
        <pre
          data-testid="git-diff-raw"
          className={cn('whitespace-pre-wrap break-words font-mono', chromeMonoRole('code'))}
        >
          {diff.text.split('\n').map((line, index) => (
            <span
              // Patch lines carry no identity of their own; position is what
              // distinguishes two byte-identical context lines.
              key={index}
              className={cn('block', LINE_CLASS[classifyDiffLine(line)])}
            >
              {line === '' ? ' ' : line}
            </span>
          ))}
        </pre>
      </div>
    );
  }

  return (
    <div data-testid="git-diff-patch" className="min-w-0">
      <PatchDiff
        patch={diff.text}
        options={options}
        disableWorkerPool
        className="block min-w-0 font-mono"
      />
    </div>
  );
}
