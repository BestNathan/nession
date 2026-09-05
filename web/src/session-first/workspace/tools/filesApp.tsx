import { useEffect, useState } from 'react';
import { FileBrowser } from '@/components/FileBrowser';
import { FileViewer } from '@/components/FileViewer';
import { AppBackButton } from '@/session-first/patterns/AppBackButton';
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
import type { FileEntry } from '@/features/files';
import type { WorkspaceContext } from '../toolTypes';

interface SelectedFile { path: string; filename: string; size: number; }

/**
 * App layout: tree full-screen → push editor with a sub-header (← + path).
 * The sub-header back is the layout's own close affordance, so it re-checks
 * the viewer's dirty state (tracked via onDirtyChange) and asks before
 * discarding — the FileViewer's own guard only covers its toolbar ✕.
 */
export function FilesAppLayout({ ctx }: { ctx: WorkspaceContext }) {
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

  const handleBackClick = () => {
    if (dirty) {
      setShowDiscardDialog(true);
      return;
    }
    setSelected(null);
  };

  const handleConfirmDiscard = () => {
    setShowDiscardDialog(false);
    setSelected(null);
  };

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          data-testid="files-app-nav"
          className="flex shrink-0 items-center gap-1 px-[var(--shell-space-2)] pt-[var(--shell-space-1)]"
        >
          <AppBackButton label="Back to files" testid="files-app-back" onClick={handleBackClick} />
          <span className="min-w-0 truncate font-mono text-sm font-semibold">{selected.filename}</span>
        </div>
        <div className="min-h-0 flex-1">
          <FileViewer
            key={selected.path}
            fileOps={ctx.fileOps}
            path={selected.path}
            filename={selected.filename}
            fileSize={selected.size}
            onClose={() => setSelected(null)}
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
      <FileBrowser
        fileOps={ctx.fileOps}
        onFileClick={handleFileClick}
      />
    </div>
  );
}
