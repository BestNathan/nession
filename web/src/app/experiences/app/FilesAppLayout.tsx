import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { resolveFileSource, type FileEntry } from '@/capabilities/files';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';
import { cn } from '@/shared/lib/utils';
import { bodyAppClass } from './appTypography';
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

  const source = useMemo(
    () =>
      resolveFileSource({
        sessionId: ctx.session?.session_id,
        agentId: ctx.agent?.agent_id,
        agentLabel: ctx.agent?.display_name ?? ctx.agent?.hostname,
        fileOps: ctx.fileOps,
      }),
    [ctx.session?.session_id, ctx.agent, ctx.fileOps],
  );

  const nav = useAppFilesNavigator(
    depth,
    {
      sessionName: ctx.session?.session_name,
      agentLabel: ctx.agent?.display_name ?? ctx.agent?.hostname,
    },
    ctx.fileOps,
    source.id,
  );

  const search = useAppFilesSearch(source.fileOps, nav.searchOpen);
  const handoffError = useAppFilesFocusHandoff(
    ctx.focus,
    source.fileOps,
    ctx.onFocusConsumed,
    nav,
  );

  const bulk = useAppFilesBulkActions(
    source.fileOps,
    selection,
    listEntriesRef as RefObject<FileEntry[]>,
    () => setListReloadSignal((n) => n + 1),
  );

  useEffect(() => {
    setMoreOpen(false);
  }, [nav.currentDir, nav.searchOpen, nav.selected]);

  if (source.fileOps === null) {
    return (
      <div
        data-testid="file-source-unavailable"
        className={cn('flex h-full items-center justify-center px-6 text-center text-muted-foreground', bodyAppClass)}
      >
        {source.reason}
      </div>
    );
  }

  if (nav.selected) {
    return (
      <AppFilesViewerLayer
        fileOps={source.fileOps}
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
      fileOps={source.fileOps}
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
