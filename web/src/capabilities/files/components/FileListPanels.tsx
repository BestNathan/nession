import { useRef } from 'react';
import { Check, ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { formatSize } from '@/shared/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import type { FileEntry } from '@/capabilities/files';

const LONG_PRESS_MS = 400;

export function FileListErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-col gap-[var(--shell-space-3)] p-[var(--shell-space-4)]"
      data-testid="files-app-list"
    >
      <div>
        <p className="text-[length:var(--workspace-list-row-title-font-size)] font-medium text-foreground">
          Couldn&apos;t load files
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function FileListLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-[var(--shell-space-3)] py-[var(--shell-space-2)]">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-[var(--shell-session-row-radius)]" />
      ))}
    </div>
  );
}

export interface FileListEntryRowsProps {
  entries: FileEntry[];
  counts: Record<string, number>;
  onEnterDirectory: (path: string) => void;
  onFileClick: (entry: FileEntry) => void;
  captureScroll: () => void;
  selectionMode?: boolean;
  isSelected?: (path: string) => boolean;
  onLongPress?: (entry: FileEntry) => void;
  onToggleSelect?: (entry: FileEntry) => void;
}

function FileListRow({
  entry,
  meta,
  selectionMode,
  selected,
  onLongPress,
  onToggleSelect,
  onEnterDirectory,
  onFileClick,
  captureScroll,
}: {
  entry: FileEntry;
  meta: string;
  selectionMode: boolean;
  selected: boolean;
  onLongPress?: (entry: FileEntry) => void;
  onToggleSelect?: (entry: FileEntry) => void;
  onEnterDirectory: (path: string) => void;
  onFileClick: (entry: FileEntry) => void;
  captureScroll: () => void;
}) {
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <button
      key={entry.path}
      type="button"
      data-testid={`file-row-${entry.path}`}
      onPointerDown={() => {
        if (!onLongPress) {
          return;
        }
        clearPress();
        pressTimer.current = setTimeout(() => {
          pressTimer.current = null;
          onLongPress(entry);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
      onClick={() => {
        if (selectionMode) {
          onToggleSelect?.(entry);
          return;
        }
        if (entry.is_dir) {
          captureScroll();
          onEnterDirectory(entry.path);
          return;
        }
        onFileClick(entry);
      }}
      className={cn(
        'flex w-full min-h-[52px] items-center gap-[var(--shell-space-3)] rounded-[var(--shell-session-row-radius)] px-[var(--shell-space-3)] py-[var(--shell-space-2)] text-left transition-colors hover:bg-muted/60',
        selectionMode && selected && 'bg-muted/80',
      )}
    >
      {selectionMode ? (
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-sm border border-border',
            selected && 'border-primary bg-primary text-primary-foreground',
          )}
          aria-hidden
        >
          {selected ? <Check className="size-3.5" /> : null}
        </span>
      ) : null}
      {entry.is_dir ? (
        <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--workspace-list-row-title-font-size)] text-foreground">
          {entry.name}
        </span>
        <span className="truncate text-[length:var(--workspace-tree-font-size)] text-muted-foreground">
          {meta}
        </span>
      </span>
      {!selectionMode && entry.is_dir ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </button>
  );
}

export function FileListEntryRows({
  entries,
  counts,
  onEnterDirectory,
  onFileClick,
  captureScroll,
  selectionMode = false,
  isSelected = () => false,
  onLongPress,
  onToggleSelect,
}: FileListEntryRowsProps) {
  if (entries.length === 0) {
    return (
      <p className="px-[var(--shell-space-3)] py-[var(--shell-space-4)] text-sm text-muted-foreground">
        This folder is empty.
      </p>
    );
  }

  return (
    <>
      {entries.map((entry) => (
        <FileListRow
          key={entry.path}
          entry={entry}
          meta={entry.is_dir ? directoryMeta(counts[entry.path]) : formatSize(entry.size)}
          selectionMode={selectionMode}
          selected={isSelected(entry.path)}
          onLongPress={onLongPress}
          onToggleSelect={onToggleSelect}
          onEnterDirectory={onEnterDirectory}
          onFileClick={onFileClick}
          captureScroll={captureScroll}
        />
      ))}
    </>
  );
}

function directoryMeta(count: number | undefined): string {
  if (count === undefined) {
    return '';
  }
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}
