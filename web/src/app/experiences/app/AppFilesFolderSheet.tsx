import { Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { FileOps } from '@/capabilities/files';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { copyToClipboard } from '@/shared/lib/clipboard';
import {
  directoryRelativePath,
  resolveDirectoryFullPath,
} from './appFilesDirectoryPaths';

export interface AppFilesFolderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderTitle: string;
  relativeDir: string;
  sessionId: string;
  fileOps: FileOps;
  onRefresh: () => void;
}

function copyLabel(text: string, label: string): void {
  void copyToClipboard(text).then(
    () => {
      toast.success(`${label} copied`);
    },
    () => {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    },
  );
}

/**
 * Folder-scoped actions for the App Files navigator (#1140).
 *
 * Overlays the current directory list; it is not a shell push depth.
 */
export function AppFilesFolderSheet({
  open,
  onOpenChange,
  folderTitle,
  relativeDir,
  sessionId,
  fileOps,
  onRefresh,
}: AppFilesFolderSheetProps) {
  const handleCopyRelative = () => {
    copyLabel(directoryRelativePath(relativeDir), 'Path');
    onOpenChange(false);
  };

  const handleCopyFull = () => {
    void resolveDirectoryFullPath(fileOps, sessionId, relativeDir).then(
      (fullPath) => {
        copyLabel(fullPath, 'Full path');
        onOpenChange(false);
      },
      () => {
        toast.error('Could not resolve full path');
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="fixed top-auto bottom-0 left-0 max-h-[min(70dvh,24rem)] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-xl border-b-0 data-open:slide-in-from-bottom-4 data-closed:slide-out-to-bottom-4"
        data-testid="files-app-folder-sheet"
      >
        <DialogHeader>
          <DialogTitle>{folderTitle}</DialogTitle>
          <DialogDescription>Folder actions</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start gap-2 px-2"
            onClick={() => {
              onRefresh();
              onOpenChange(false);
            }}
          >
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start gap-2 px-2"
            onClick={handleCopyRelative}
          >
            <Copy className="size-4" aria-hidden />
            Copy path
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start gap-2 px-2"
            onClick={handleCopyFull}
          >
            <Copy className="size-4" aria-hidden />
            Copy full path
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
