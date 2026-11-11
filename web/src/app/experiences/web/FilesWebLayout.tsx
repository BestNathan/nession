import { useCallback, useMemo } from 'react';
import {
  FileBrowser,
  FileViewer,
  makeFileRef,
  resolveFileSource,
  type FileEntry,
} from '@/capabilities/files';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { WorkspaceMasterDetail } from '@/app/workspace/layout/workspaceLayout';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { useFilesWebFocusHandoff, type WebFilesFocusTarget } from './useFilesWebFocusHandoff';
import { FilesWebSwitchDialog } from './FilesWebSwitchDialog';
import { useFilesWebSwitchGuard } from './useFilesWebSwitchGuard';

/** Web layout: tree ‖ editor on a CSS grid — proportions, no fixed px. */
export function FilesWebLayout({ ctx }: { ctx: WorkspaceContext }) {
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
  const resetKey = useMemo(() => [source.id, ctx.fileOps], [source.id, ctx.fileOps]);
  const guard = useFilesWebSwitchGuard(resetKey);
  const { requestFile } = guard;

  const openFocusTarget = useCallback((target: WebFilesFocusTarget) => {
    requestFile({
      ref: { sourceId: source.id, path: target.path },
      filename: target.name,
      size: target.size,
      line: target.line,
      column: target.column,
    });
  }, [requestFile, source.id]);
  const handoffError = useFilesWebFocusHandoff({
    focus: ctx.focus,
    fileOps: source.fileOps,
    sessionId: ctx.session?.session_id,
    onFocusConsumed: ctx.onFocusConsumed,
    onOpenFile: openFocusTarget,
  });


  if (source.fileOps === null) {
    return (
      <div
        data-testid="file-source-unavailable"
        className={cn('flex h-full items-center justify-center px-6 text-center text-muted-foreground', chromeSansRole('secondary'))}
      >
        {source.reason}
      </div>
    );
  }

  return (
    <div data-testid="file-workspace" className="h-full min-h-0 overflow-hidden">
      {handoffError ? (
        <p
          data-testid="files-web-handoff-error"
          className={cn('border-b border-border/40 px-3 py-2 text-destructive', chromeSansRole('secondary'))}
          role="status"
        >
          {handoffError}
        </p>
      ) : null}
      {/* A fixed navigation column and a fluid editor, not two fractions. The
          mockup draws the tree at 208px because it is sized to its content —
          paths — and a `1fr 2fr` split hands it a third of the pane whatever it
          holds. No border either: the tree carries `workspace.navigation` (the
          chrome surface) and the editor keeps the canvas, so the background
          shift is the separator, as in the shell (visual-language.md P7).
          This relationship is the shared recipe (#3194); a consumer that
          restates the grid is the drift the layout Gate rejects. */}
      <WorkspaceMasterDetail
        data-testid="files-web-layout"
        navigation={
          <FileBrowser
            fileOps={source.fileOps}
            selectedPath={guard.selected?.ref.path ?? null}
            onFileClick={(entry: FileEntry) => {
              const ref = makeFileRef(source, entry.path);
              if (ref === null) {
                return true;
              }
              return requestFile({ ref, filename: entry.name, size: entry.size });
            }}
          />
        }
      >
        {guard.selected ? (
          <FileViewer
            key={`${source.id}:${guard.selected.ref.path}`}
            fileOps={source.fileOps}
            path={guard.selected.ref.path}
            filename={guard.selected.filename}
            fileSize={guard.selected.size}
            initialLine={guard.selected.line}
            initialColumn={guard.selected.column}
            onClose={guard.closeFile}
            onDirtyChange={guard.onDirtyChange}
            onSavingChange={guard.onSavingChange}
            onSaveHandlerChange={guard.onSaveHandlerChange}
          />
        ) : (
          <div className={cn('flex h-full items-center justify-center text-muted-foreground', chromeSansRole('secondary'))}>Select a file to view it.</div>
        )}
      </WorkspaceMasterDetail>
      <FilesWebSwitchDialog selected={guard.selected} state={guard.switchState} />
    </div>
  );
}
