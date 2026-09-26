import { useCallback, useEffect, useState } from 'react';
import { FileList, FileViewer, type FileEntry } from '@/capabilities/files';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';

interface SelectedFile { path: string; filename: string; size: number; }

/**
 * App layout: the file list at the capability root, the viewer pushed over it.
 *
 * `#1051` is why this file got smaller. It used to render its own push
 * sub-header (← + path) *underneath* the Workspace page header, which itself sat
 * underneath the file viewer's own bar (path + Edit/Save + ✕) — three rows, two
 * of which offered a way out of the same editor. The push is now a depth the
 * layout declares (`depth.setPush`), so the shell's one page header renders it,
 * and the only leave action is that header's Back.
 *
 * The guard travels with the state it protects: `onLeave` is this layout's
 * dirty-checking handler, so the shell's Back cannot discard an unsaved editor
 * even though the shell does not know an editor exists. The viewer's own ✕ is
 * gone with the row it lived in — `FileViewer` renders no close affordance when
 * it is not given one, which is exactly this composition. `#1051` names that as
 * the defect: Back and ✕ were two controls with the same meaning.
 */
export function FilesAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  // Reset the viewer when the transport changes (detach/reattach or session
  // switch) so a stale file view from a previous session never reappears.
  // A dirty editor is dropped unconditionally here — that's the existing
  // transport-change semantics.
  useEffect(() => {
    setSelected(null);
  }, [ctx.fileOps]);

  const handleBackClick = useCallback(() => {
    if (dirty) {
      setShowDiscardDialog(true);
      return;
    }
    setSelected(null);
  }, [dirty]);

  const setPush = depth.setPush;
  const pushedTitle = selected ? selected.filename : null;
  // Declared, not rendered. `setPush` is called from an effect rather than
  // during render because the header it feeds is a sibling, and it re-runs only
  // when the depth's own identity changes — `handleBackClick` is stable for as
  // long as `dirty` is.
  useEffect(() => {
    setPush(pushedTitle === null ? null : { title: pushedTitle, onLeave: handleBackClick });
  }, [setPush, pushedTitle, handleBackClick]);

  if (!ctx.fileOps) {
    return null;
  }

  const handleFileClick = (entry: FileEntry) => {
    // A fresh push starts clean; dirty state from a previously closed
    // (possibly discarded) editor must not leak into the next file.
    setDirty(false);
    setShowDiscardDialog(false);
    setSelected({ path: entry.path, filename: entry.name, size: entry.size });
  };

  const handleConfirmDiscard = () => {
    setShowDiscardDialog(false);
    setSelected(null);
  };

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <FileViewer
            key={selected.path}
            fileOps={ctx.fileOps}
            path={selected.path}
            filename={selected.filename}
            fileSize={selected.size}
            onDirtyChange={setDirty}
          />
        </div>
        <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes. Leave anyway?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmDiscard}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Leave without saving
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden" data-testid="files-app-layout">
      <FileList fileOps={ctx.fileOps} onFileClick={handleFileClick} />
    </div>
  );
}
