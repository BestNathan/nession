import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FileEntry } from '@/capabilities/files';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';
import { AppFilesDirectoryPane } from './AppFilesDirectoryPane';
import { AppFilesSearchPanel } from './AppFilesSearchPanel';
import { AppFilesViewerLayer } from './AppFilesViewerLayer';
import { useAppFilesBulkActions } from './useAppFilesBulkActions';
import { useAppFilesFocusHandoff } from './useAppFilesFocusHandoff';
import { useAppFilesNavigator } from './useAppFilesNavigator';
import { useAppFilesSearch } from './useAppFilesSearch';
import { useAppFilesSelection } from './useAppFilesSelection';

/**
 * App layout: directory navigator at the capability root, file viewer pushed over it.
 */
export function FilesAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [listReloadSignal, setListReloadSignal] = useState(0);
  const listEntriesRef = useRef<FileEntry[]>([]);

  const selection = useAppFilesSelection();

  const nav = useAppFilesNavigator(
    depth,
    {
      sessionName: ctx.session?.session_name,
      agentLabel: ctx.agent?.display_name ?? ctx.agent?.hostname,
    },
    ctx.fileOps,
  );

  const search = useAppFilesSearch(ctx.fileOps, nav.searchOpen);
  const handoffError = useAppFilesFocusHandoff(ctx.focus, ctx.fileOps, ctx.onFocusConsumed, nav);

  const bulk = useAppFilesBulkActions(
    ctx.fileOps,
    selection,
    listEntriesRef as RefObject<FileEntry[]>,
    () => setListReloadSignal((n) => n + 1),
  );

  useEffect(() => {
    setMoreOpen(false);
  }, [nav.currentDir, nav.searchOpen, nav.selected]);

  if (!ctx.fileOps) {
    return null;
  }

  if (nav.selected) {
    return (
      <AppFilesViewerLayer
        fileOps={ctx.fileOps}
        path={nav.selected.path}
        filename={nav.selected.filename}
        size={nav.selected.size}
        initialLine={nav.selected.initialLine}
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
        onSelectFile={(entry) => nav.openFile(entry)}
        onRetry={search.retry}
      />
    );
  }

  return (
    <AppFilesDirectoryPane
      fileOps={ctx.fileOps}
      nav={nav}
      selection={selection}
      bulk={bulk}
      handoffError={handoffError}
      listEntriesRef={listEntriesRef as RefObject<FileEntry[]>}
      listReloadSignal={listReloadSignal}
      moreOpen={moreOpen}
      setMoreOpen={setMoreOpen}
      sessionId={ctx.session?.session_id ?? ''}
      onListReload={() => setListReloadSignal((n) => n + 1)}
      onEntriesChange={(entries) => {
        listEntriesRef.current = entries;
      }}
    />
  );
}
