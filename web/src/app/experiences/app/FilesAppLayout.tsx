import { useEffect, useState } from 'react';
import { FileList, type FileEntry } from '@/capabilities/files';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';
import { directoryPageTitle } from './appFilesNavigation';
import { AppFilesBreadcrumb } from './AppFilesBreadcrumb';
import { AppFilesFolderSheet } from './AppFilesFolderSheet';
import { AppFilesSearchPanel } from './AppFilesSearchPanel';
import { AppFilesViewerLayer } from './AppFilesViewerLayer';
import { useAppFilesNavigator } from './useAppFilesNavigator';
import { useAppFilesSearch } from './useAppFilesSearch';

/**
 * App layout: directory navigator at the capability root, file viewer pushed over it.
 *
 * `#1140` replaces in-place path swaps with a stack the shell can Back out of:
 * one directory per screen, scroll positions preserved, breadcrumb for jumps.
 * The file viewer remains a second push depth declared the same way as `#1051`.
 */
export function FilesAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [listReloadSignal, setListReloadSignal] = useState(0);

  const nav = useAppFilesNavigator(
    depth,
    {
      sessionName: ctx.session?.session_name,
      agentLabel: ctx.agent?.display_name ?? ctx.agent?.hostname,
    },
    ctx.fileOps,
  );

  const search = useAppFilesSearch(ctx.fileOps, nav.searchOpen);

  useEffect(() => {
    setMoreOpen(false);
  }, [nav.currentDir, nav.searchOpen, nav.selected]);

  if (!ctx.fileOps) {
    return null;
  }

  const handleFileClick = (entry: FileEntry) => {
    nav.openFile(entry);
  };

  if (nav.selected) {
    return (
      <AppFilesViewerLayer
        fileOps={ctx.fileOps}
        path={nav.selected.path}
        filename={nav.selected.filename}
        size={nav.selected.size}
        onDirtyChange={nav.setDirty}
        showDiscardDialog={nav.showDiscardDialog}
        onDiscardDialogChange={nav.setShowDiscardDialog}
        onConfirmDiscard={nav.confirmDiscard}
      />
    );
  }

  if (nav.searchOpen) {
    return (
      <AppFilesSearchPanel
        query={search.query}
        onQueryChange={search.setQuery}
        status={search.status}
        error={search.error}
        results={search.results}
        onSelectFile={handleFileClick}
        onRetry={search.retry}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="files-app-layout">
      <AppFilesBreadcrumb
        segments={nav.breadcrumbSegments}
        onSelect={nav.navigateToPath}
        onOpenSearch={nav.openSearch}
        onOpenMore={() => setMoreOpen(true)}
      />
      <div className="min-h-0 flex-1">
        <FileList
          fileOps={ctx.fileOps}
          path={nav.currentDir}
          onEnterDirectory={nav.enterDirectory}
          onFileClick={handleFileClick}
          restoredScrollTop={nav.restoredScrollTop}
          onScrollSnapshot={nav.snapshotScroll}
          workspaceContextLine={nav.workspaceContextLine}
          reloadSignal={listReloadSignal}
        />
      </div>
      <AppFilesFolderSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        folderTitle={directoryPageTitle(nav.currentDir)}
        relativeDir={nav.currentDir}
        sessionId={ctx.session?.session_id ?? ''}
        fileOps={ctx.fileOps}
        onRefresh={() => setListReloadSignal((n) => n + 1)}
      />
    </div>
  );
}
