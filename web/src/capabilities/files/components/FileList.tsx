import { useEffect, useState } from 'react';
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSize } from '@/lib/format';
import type { FileOps, FileEntry } from '@/capabilities/files';

export interface FileListProps {
  fileOps: FileOps;
  onFileClick: (entry: FileEntry) => void;
  /** Directory to open at. Defaults to the transport's working directory. */
  initialPath?: string;
}

/**
 * The App's Files view: a sectioned list, not a tree.
 *
 * `app.md`'s rule is that a capability owns its internal flows — "Files may push
 * an editor; Claude Code may open configuration/history; Git may expose
 * repository state. These are capability-internal flows, not a requirement for
 * one shared master/detail shell." App reused the Web tree anyway; the mockup
 * draws a list, and the phone is where the tree's indentation costs the most and
 * buys the least.
 *
 * One directory per screen, with the path as the section header. Descending
 * replaces the section rather than indenting under it, which is what makes the
 * rows wide enough to carry a name and a meta line at phone width.
 *
 * **Directory rows cost a `listDir` each**, to fill their "N items" meta. The
 * mockup draws that count and pays nothing for it; here a directory holding
 * fifteen subdirectories costs fifteen round-trips through the relay on screen
 * open. That is the honest cost of the meta, and it is worth revisiting —
 * either the transport should report child counts, or the meta should fill in
 * lazily — but neither is in scope for a list that needs to exist first.
 */
export function FileList({ fileOps, onFileClick, initialPath = '' }: FileListProps) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEntries(null);

    void fileOps.listDir(path).then(
      ({ entries: listed }) => {
        if (cancelled) {
          return;
        }
        setEntries(listed);
        // Child counts, one `listDir` per subdirectory. See the component note:
        // this is the meta's real price and it is paid on every screen.
        for (const entry of listed) {
          if (!entry.is_dir) {
            continue;
          }
          void fileOps.listDir(entry.path).then(
            ({ entries: children }) => {
              if (!cancelled) {
                setCounts((prev) => ({ ...prev, [entry.path]: children.length }));
              }
            },
            () => {
              // A directory that cannot be listed gets no count rather than an
              // error: it is metadata beside the row, not the row itself.
            },
          );
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not list this directory');
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [fileOps, path]);

  if (error !== null) {
    return (
      <div className="p-[var(--shell-space-4)] text-sm text-muted-foreground" data-testid="files-app-list">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="files-app-list">
      <div className="sticky top-0 z-1 bg-background px-[var(--shell-space-3)] pt-[var(--shell-space-2)] pb-[var(--shell-space-1)] font-mono text-[length:var(--workspace-tree-font-size)] text-muted-foreground">
        {path ?? ''}
      </div>
      {entries?.map((entry) => (
        <button
          key={entry.path}
          type="button"
          data-testid={`file-row-${entry.path}`}
          onClick={() => (entry.is_dir ? setPath(entry.path) : onFileClick(entry))}
          className={cn(
            'flex w-full items-center gap-[var(--shell-space-3)] rounded-[var(--shell-session-row-radius)] px-[var(--shell-space-3)] py-[var(--shell-space-2)] text-left transition-colors hover:bg-muted/60',
          )}
        >
          {entry.is_dir ? (
            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{entry.name}</span>
            <span className="truncate text-[length:var(--workspace-tree-font-size)] text-muted-foreground">
              {entry.is_dir ? directoryMeta(counts[entry.path]) : formatSize(entry.size)}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** "2 files" / "1 file", or nothing until the count arrives. */
function directoryMeta(count: number | undefined): string {
  if (count === undefined) {
    return '';
  }
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}
