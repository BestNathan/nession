import { FileViewer, type FileOps } from '@/capabilities/files';
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

export interface AppFilesViewerLayerProps {
  fileOps: FileOps;
  path: string;
  filename: string;
  size: number;
  initialLine?: number;
  onDirtyChange: (dirty: boolean) => void;
  showDiscardDialog: boolean;
  onDiscardDialogChange: (open: boolean) => void;
  onConfirmDiscard: () => void;
}

export function AppFilesViewerLayer({
  fileOps,
  path,
  filename,
  size,
  initialLine,
  onDirtyChange,
  showDiscardDialog,
  onDiscardDialogChange,
  onConfirmDiscard,
}: AppFilesViewerLayerProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <FileViewer
          key={path}
          fileOps={fileOps}
          path={path}
          filename={filename}
          fileSize={size}
          initialLine={initialLine}
          onDirtyChange={onDirtyChange}
        />
      </div>
      <AlertDialog open={showDiscardDialog} onOpenChange={onDiscardDialogChange}>
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
              onClick={onConfirmDiscard}
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
