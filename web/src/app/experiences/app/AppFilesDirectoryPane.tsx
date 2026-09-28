import type { RefObject } from 'react';
import { FileList, type FileEntry, type FileOps } from '@/capabilities/files';
import { AppFilesBreadcrumb } from './AppFilesBreadcrumb';
import { AppFilesDeleteDialog } from './AppFilesDeleteDialog';
import { AppFilesFolderSheet } from './AppFilesFolderSheet';
import {
  AppFilesSelectionBottomBar,
  AppFilesSelectionTopBar,
} from './AppFilesSelectionChrome';
import { directoryPageTitle } from './appFilesNavigation';
import type { useAppFilesBulkActions } from './useAppFilesBulkActions';
import type { useAppFilesNavigator } from './useAppFilesNavigator';
import type { useAppFilesSelection } from './useAppFilesSelection';

type Nav = ReturnType<typeof useAppFilesNavigator>;
type Selection = ReturnType<typeof useAppFilesSelection>;
type Bulk = ReturnType<typeof useAppFilesBulkActions>;

export function AppFilesDirectoryPane({
  fileOps,
  nav,
  selection,
  bulk,
  handoffError,
  listEntriesRef,
  listReloadSignal,
  moreOpen,
  setMoreOpen,
  sessionId,
  onListReload,
  onEntriesChange,
}: {
  fileOps: FileOps;
  nav: Nav;
  selection: Selection;
  bulk: Bulk;
  handoffError: string | null;
  listEntriesRef: RefObject<FileEntry[]>;
  listReloadSignal: number;
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
  sessionId: string;
  onListReload: () => void;
  onEntriesChange: (entries: FileEntry[]) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="files-app-layout">
      {selection.active ? (
        <AppFilesSelectionTopBar
          summary={selection.summary}
          onExit={() => selection.exit()}
          onSelectAll={() => selection.selectAll(listEntriesRef.current ?? [])}
        />
      ) : (
        <AppFilesBreadcrumb
          segments={nav.breadcrumbSegments}
          onSelect={nav.navigateToPath}
          onOpenSearch={nav.openSearch}
          onOpenMore={() => setMoreOpen(true)}
        />
      )}
      {handoffError ? (
        <p
          className="px-[var(--shell-space-3)] py-2 text-sm text-destructive"
          data-testid="files-app-handoff-error"
        >
          {handoffError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <FileList
          fileOps={fileOps}
          path={nav.currentDir}
          onEnterDirectory={nav.enterDirectory}
          onFileClick={(entry) => nav.openFile(entry)}
          restoredScrollTop={nav.restoredScrollTop}
          onScrollSnapshot={nav.snapshotScroll}
          workspaceContextLine={nav.workspaceContextLine}
          reloadSignal={listReloadSignal}
          onEntriesChange={onEntriesChange}
          selectionMode={selection.active}
          isSelected={selection.isSelected}
          onLongPress={(entry) => selection.enterWith(entry)}
          onToggleSelect={(entry) => selection.toggle(entry)}
        />
      </div>
      {selection.active ? (
        <AppFilesSelectionBottomBar
          disabled={selection.count === 0}
          onCopy={() => bulk.handleCopySelected()}
          onDelete={() => bulk.setDeleteOpen(true)}
        />
      ) : null}
      <AppFilesFolderSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        folderTitle={directoryPageTitle(nav.currentDir)}
        relativeDir={nav.currentDir}
        sessionId={sessionId}
        fileOps={fileOps}
        onRefresh={onListReload}
      />
      <AppFilesDeleteDialog
        open={bulk.deleteOpen}
        onOpenChange={bulk.setDeleteOpen}
        count={selection.count}
        onConfirm={() => bulk.confirmDelete()}
      />
    </div>
  );
}
