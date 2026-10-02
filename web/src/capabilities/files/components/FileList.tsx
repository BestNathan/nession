import { useEffect, useRef, useState } from 'react';
import type { FileOps, FileEntry } from '@/capabilities/files';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import {
  FileListEntryRows,
  FileListErrorPanel,
  FileListLoadingSkeleton,
} from './FileListPanels';

export interface FileListProps {
  fileOps: FileOps;
  onFileClick: (entry: FileEntry) => void;
  path: string;
  onEnterDirectory: (path: string) => void;
  restoredScrollTop?: number;
  onScrollSnapshot?: (scrollTop: number) => void;
  workspaceContextLine?: string | null;
  /** Increment to re-fetch the current directory (#1140 folder sheet). */
  reloadSignal?: number;
  onEntriesChange?: (entries: FileEntry[]) => void;
  selectionMode?: boolean;
  isSelected?: (path: string) => boolean;
  onLongPress?: (entry: FileEntry) => void;
  onToggleSelect?: (entry: FileEntry) => void;
}

/**
 * The App's Files view: a sectioned list, not a tree (#1140).
 */
export function FileList({
  fileOps,
  onFileClick,
  path,
  onEnterDirectory,
  restoredScrollTop,
  onScrollSnapshot,
  workspaceContextLine,
  reloadSignal = 0,
  onEntriesChange,
  selectionMode,
  isSelected,
  onLongPress,
  onToggleSelect,
}: FileListProps) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

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
        onEntriesChange?.(listed);
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
            () => {},
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
  }, [fileOps, path, reloadToken, reloadSignal, onEntriesChange]);

  useEffect(() => {
    if (restoredScrollTop === undefined || entries === null) {
      return;
    }
    const node = listRef.current;
    if (node) {
      node.scrollTop = restoredScrollTop;
    }
  }, [entries, restoredScrollTop, path]);

  if (error !== null) {
    return (
      <FileListErrorPanel message={error} onRetry={() => setReloadToken((t) => t + 1)} />
    );
  }

  const atRoot = path === '';

  return (
    <div
      ref={listRef}
      className={cn('h-full min-h-0 overflow-y-auto', workspaceScrollClearanceClass)}
      data-testid="files-app-list"
      onScroll={() => {
        const node = listRef.current;
        if (node && onScrollSnapshot) {
          onScrollSnapshot(node.scrollTop);
        }
      }}
    >
      {atRoot && workspaceContextLine ? (
        <p
          className={cn(
            'px-[var(--shell-space-3)] pt-[var(--shell-space-1)] text-muted-foreground',
            chromeSansRole('secondary'),
          )}
          data-testid="files-app-root-context"
        >
          {workspaceContextLine}
        </p>
      ) : null}
      {entries === null ? (
        <FileListLoadingSkeleton />
      ) : (
        <FileListEntryRows
          entries={entries}
          counts={counts}
          onEnterDirectory={onEnterDirectory}
          onFileClick={onFileClick}
          captureScroll={() => onScrollSnapshot?.(listRef.current?.scrollTop ?? 0)}
          selectionMode={selectionMode}
          isSelected={isSelected}
          onLongPress={onLongPress}
          onToggleSelect={onToggleSelect}
        />
      )}
    </div>
  );
}
