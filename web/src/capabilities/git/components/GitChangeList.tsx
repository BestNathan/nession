import { FileText, Plus, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { GitRow } from '../state';

const GROUPS = [
  { id: 'conflicts', title: 'Conflicts', matches: (row: GitRow) => row.kind === 'unmerged' },
  { id: 'staged', title: 'Staged', matches: (row: GitRow) => row.kind === 'staged' },
  { id: 'changes', title: 'Changes', matches: (row: GitRow) => row.kind === 'unstaged' },
  { id: 'untracked', title: 'Untracked', matches: (row: GitRow) => row.kind === 'untracked' },
] as const;

/**
 * The repository's changes, grouped by what the index and worktree say.
 *
 * Staged and unstaged are separate groups because they are different reviewed
 * states — a file can be in both, and the two rows open different diffs. Each
 * actionable row carries the write for its own group: Stage for the worktree
 * side, Unstage for the index side. Conflicted rows stay inert: resolving a
 * merge is not a staging action (#845 Non-Goals).
 *
 * Takes the rows rather than the status so the caller derives them once: an
 * empty tree is a *layout* decision (the workspace drops the diff pane), and it
 * is taken one level up.
 */
export function GitChangeList({
  rows,
  selectedKey,
  onSelect,
  busyKey,
  onStage,
  onUnstage,
}: {
  rows: readonly GitRow[];
  selectedKey: string | null;
  onSelect: (row: GitRow) => void;
  busyKey: string | null;
  onStage: (row: GitRow) => void;
  onUnstage: (row: GitRow) => void;
}) {
  return (
    <div data-testid="git-change-list" className="space-y-4 p-3">
      {GROUPS.map((group) => {
        const members = rows.filter((row) => group.matches(row));
        if (members.length === 0) {
          return null;
        }
        return (
          <section key={group.id} data-testid={`git-group-${group.id}`}>
            <h2 className={cn('mb-1 px-2 text-muted-foreground', chromeLabelRole())}>
              {group.title} ({members.length})
            </h2>
            <div className="space-y-0.5">
              {members.map((row) => (
                <GitRowItem
                  key={row.key}
                  row={row}
                  selected={row.key === selectedKey}
                  busy={busyKey === row.key}
                  disabled={busyKey !== null}
                  onSelect={onSelect}
                  onStage={onStage}
                  onUnstage={onUnstage}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function GitRowItem({
  row,
  selected,
  busy,
  disabled,
  onSelect,
  onStage,
  onUnstage,
}: {
  row: GitRow;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: (row: GitRow) => void;
  onStage: (row: GitRow) => void;
  onUnstage: (row: GitRow) => void;
}) {
  const label = rowLabel(row);
  const action =
    row.kind === 'staged'
      ? { id: 'unstage', label: `Unstage ${row.path}`, Icon: Undo2, run: () => onUnstage(row) }
      : row.kind === 'unstaged' || row.kind === 'untracked'
        ? { id: 'stage', label: `Stage ${row.path}`, Icon: Plus, run: () => onStage(row) }
        : null;

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-[var(--nession-radius-control)]',
        selected && 'bg-accent text-accent-foreground',
      )}
    >
      <button
        type="button"
        data-testid={`git-row-${row.kind}`}
        data-path={row.path}
        aria-label={row.path}
        title={rowTitle(row)}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(row)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-[var(--nession-radius-control)] px-2 py-1.5 text-left transition-colors',
          chromeSansRole('secondary'),
          'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
        )}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{row.path}</span>
        {label ? (
          <span
            className={cn(
              'shrink-0 text-muted-foreground',
              chromeSansRole('metadata'),
            )}
          >
            {label}
          </span>
        ) : null}
      </button>
      {action ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid={`git-${action.id}`}
          aria-label={action.label}
          title={action.label}
          aria-busy={busy || undefined}
          disabled={disabled}
          onClick={action.run}
          className={cn(busy && 'opacity-60')}
        >
          <action.Icon className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What a row adds to what its group already says — usually nothing.
 *
 * The heading says staged/changed/untracked, so repeating the group's own word
 * on every row is decoration; `renamed`, `copied` and `typechanged` still earn
 * the space.
 */
function rowLabel(row: GitRow): string | null {
  if (row.kind === 'untracked' || row.kind === 'unmerged') {
    return null;
  }
  return row.file.kind === 'modified' ? null : row.file.kind;
}

/**
 * The full description, for the row's tooltip.
 *
 * A rename's old path is real information the row cannot show inline without
 * squeezing the filename it is about, so it goes where the filename is still
 * readable and the detail is one hover away.
 */
function rowTitle(row: GitRow): string {
  if ((row.kind === 'staged' || row.kind === 'unstaged') && row.file.original_path) {
    return `${row.file.original_path} → ${row.path}`;
  }
  return row.path;
}
