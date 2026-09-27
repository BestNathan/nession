import { FileList, type FileEntry } from '@/capabilities/files';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';
import { AppFilesBreadcrumb } from './AppFilesBreadcrumb';
import { AppFilesViewerLayer } from './AppFilesViewerLayer';
import { useAppFilesNavigator } from './useAppFilesNavigator';

/**
 * App layout: directory navigator at the capability root, file viewer pushed over it.
 *
 * `#1140` replaces in-place path swaps with a stack the shell can Back out of:
 * one directory per screen, scroll positions preserved, breadcrumb for jumps.
 * The file viewer remains a second push depth declared the same way as `#1051`.
 */
export function FilesAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  const nav = useAppFilesNavigator(
    depth,
    {
      sessionName: ctx.session?.name,
      agentLabel: ctx.agent?.name ?? ctx.agent?.hostname,
    },
    ctx.fileOps,
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="files-app-layout">
      <AppFilesBreadcrumb segments={nav.breadcrumbSegments} onSelect={nav.navigateToPath} />
      <div className="min-h-0 flex-1">
        <FileList
          fileOps={ctx.fileOps}
          path={nav.currentDir}
          onEnterDirectory={nav.enterDirectory}
          onFileClick={handleFileClick}
          restoredScrollTop={nav.restoredScrollTop}
          onScrollSnapshot={nav.snapshotScroll}
          workspaceContextLine={nav.workspaceContextLine}
        />
      </div>
    </div>
  );
}
