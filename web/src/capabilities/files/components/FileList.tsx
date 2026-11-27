import { useEffect, useRef } from 'react';
import type { FileOps, FileEntry } from '@/capabilities/files';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import { useAppDirectoryList } from '@/capabilities/files/hooks/useAppDirectoryList';
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

const NO_CHILD_COUNTS: Record<string, number> = Object.freeze({});

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
  const { entries, error, retry } = useAppDirectoryList({
    fileOps,
    path,
    reloadSignal,
    onEntriesChange,
  });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (restoredScrollTop === undefined || entries === null) {
      return;
    }
    const node = listRef.current;
    if (node) {
      node.scrollTop = restoredScrollTop;
    }
  }, [entries, restoredScrollTop, path]);

  // A failed background refresh keeps the last known rows on screen (stale);
  // only a failure with no answer yet is the error panel's Retry state.
  if (error !== null && entries === null) {
    return <FileListErrorPanel message={error} onRetry={() => retry()} />;
  }

  const atRoot = path === '';

  return (
    <WorkspaceBoundedScrollport
      ref={listRef}
      viewportClassName="h-full"
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
            'px-[var(--nession-shell-space-3)] pt-[var(--nession-shell-space-1)] text-muted-foreground',
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
          counts={NO_CHILD_COUNTS}
          onEnterDirectory={onEnterDirectory}
          onFileClick={onFileClick}
          captureScroll={() => onScrollSnapshot?.(listRef.current?.scrollTop ?? 0)}
          selectionMode={selectionMode}
          isSelected={isSelected}
          onLongPress={onLongPress}
          onToggleSelect={onToggleSelect}
        />
      )}
    </WorkspaceBoundedScrollport>
  );
}
