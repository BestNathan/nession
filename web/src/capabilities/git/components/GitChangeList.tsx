import { FileText } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { isSelectable, type GitRow } from '../state';

const GROUPS = ['Conflicts', 'Modified', 'Untracked'] as const;

function groupOf(row: GitRow): (typeof GROUPS)[number] {
  if (row.kind === 'unmerged') {
    return 'Conflicts';
  }
  return row.kind === 'tracked' ? 'Modified' : 'Untracked';
}

/**
 * The repository's changes, grouped.
 *
 * Modified and untracked are separate groups (#750 SC2) and they are *not*
 * interchangeable rows: an untracked file has no diff, so its row renders as
 * text rather than a control. The grouping is a fact about the repository, not a
 * visual preference — `git diff HEAD` answers nothing for an untracked path, and
 * a row that looks openable but opens onto an empty pane is worse than one that
 * plainly is not.
 *
 * Takes the rows rather than the status so that the caller derives them once:
 * an empty tree is a *layout* decision (the workspace drops the diff pane), and
 * it is taken one level up. An empty branch here would be unreachable code that
 * reads like a state the view handles.
 */
export function GitChangeList({
  rows,
  selectedPath,
  onSelect,
}: {
  rows: readonly GitRow[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div data-testid="git-change-list" className="space-y-4 p-3">
      {GROUPS.map((title) => {
        const group = rows.filter((row) => groupOf(row) === title);
        if (group.length === 0) {
          return null;
        }
        return (
          <section key={title} data-testid={`git-group-${title.toLowerCase()}`}>
            <h2 className="mb-1 px-2 text-xs font-semibold text-muted-foreground">
              {title} ({group.length})
            </h2>
            <div className="space-y-0.5">
              {group.map((row) => (
                <GitRowItem
                  key={`${row.kind}:${row.path}`}
                  row={row}
                  selected={row.path === selectedPath}
                  onSelect={onSelect}
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
  onSelect,
}: {
  row: GitRow;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const label = rowLabel(row);

  if (!isSelectable(row)) {
    // No control at all — not a disabled one. An inert row that reads as
    // pressable would be a promise the capability cannot keep.
    return (
      <div
        data-testid={`git-row-${row.kind}`}
        data-path={row.path}
        title={rowTitle(row)}
        className="flex items-center gap-2 px-2 py-1.5 text-sm"
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-muted-foreground">{row.path}</span>
        {label ? <span className="shrink-0 text-xs text-muted-foreground">{label}</span> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid="git-row-tracked"
      data-path={row.path}
      aria-label={row.path}
      title={rowTitle(row)}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(row.path)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-accent text-accent-foreground',
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{row.path}</span>
      {label ? <span className="shrink-0 text-xs text-muted-foreground">{label}</span> : null}
    </button>
  );
}

/**
 * What a row adds to what its group already says — usually nothing.
 *
 * The heading reads "Modified (3)", so repeating `modified` on all three rows is
 * decoration; the same for `untracked`. What the heading does *not* say is
 * `renamed`, `copied` or `typechanged`, so those still earn the space. Returns
 * `null` when the group has already said it.
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
  if (isSelectable(row) && row.file.originalPath) {
    return `${row.file.originalPath} → ${row.path}`;
  }
  return row.path;
}
