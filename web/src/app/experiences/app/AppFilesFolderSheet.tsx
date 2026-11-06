import { useState } from 'react';
import { Copy, FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  fileErrorMessage,
  joinPath,
  validateEntryName,
  type CreateKind,
  type FileOps,
} from '@/capabilities/files';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { copyToClipboard } from '@/shared/lib/clipboard';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
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
  /** Push the freshly created file into the read-first viewer. */
  onCreatedFile?: (entry: { path: string; name: string; size: number }) => void;
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
 * Create actions for the folder the sheet was opened on.
 *
 * The destination is the sheet's captured `relativeDir`, not a later browse
 * position: this is the App's explicit folder-context operation, and the form
 * displays the resulting path before submit.
 */
function AppFilesCreateSection({
  relativeDir,
  fileOps,
  onDone,
  onRefresh,
  onCreatedFile,
}: {
  relativeDir: string;
  fileOps: FileOps;
  onDone: () => void;
  onRefresh: () => void;
  onCreatedFile?: (entry: { path: string; name: string; size: number }) => void;
}) {
  const [kind, setKind] = useState<CreateKind | null>(null);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const validationError = kind === null ? null : validateEntryName(name);
  const destinationPath = kind === null ? '' : joinPath(relativeDir, name.trim());
  const canSubmit = kind !== null && validationError === null && !busy;

  const handleCreate = async () => {
    if (kind === null || validationError !== null) {
      return;
    }
    setBusy(true);
    setCreateError(null);
    const createdName = name.trim();
    const path = joinPath(relativeDir, createdName);
    try {
      if (kind === 'file') {
        await fileOps.writeFile(path, '', { createOnly: true });
        toast.success(`Created ${createdName}`);
        onRefresh();
        onDone();
        onCreatedFile?.({ path, name: createdName, size: 0 });
      } else {
        await fileOps.createDir(path, { createOnly: true });
        toast.success(`Created ${createdName}/`);
        onRefresh();
        onDone();
      }
    } catch (err) {
      // Keep the form and the typed name so the user can correct it.
      setCreateError(
        fileErrorMessage(err, kind === 'file' ? 'create file' : 'create folder'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full justify-start gap-2 px-2"
        onClick={() => {
          setKind('file');
          setName('');
          setCreateError(null);
        }}
      >
        <FilePlus className="size-4" aria-hidden />
        New file
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full justify-start gap-2 px-2"
        onClick={() => {
          setKind('folder');
          setName('');
          setCreateError(null);
        }}
      >
        <FolderPlus className="size-4" aria-hidden />
        New folder
      </Button>
      {kind !== null && (
        <AppFilesCreateForm
          kind={kind}
          name={name}
          destinationPath={destinationPath}
          relativeDir={relativeDir}
          validationError={validationError}
          createError={createError}
          canSubmit={canSubmit}
          onNameChange={setName}
          onSubmit={() => void handleCreate()}
          onCancel={() => setKind(null)}
        />
      )}
    </div>
  );
}

function AppFilesCreateForm({
  kind,
  name,
  destinationPath,
  relativeDir,
  validationError,
  createError,
  canSubmit,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  kind: CreateKind;
  name: string;
  destinationPath: string;
  relativeDir: string;
  validationError: string | null;
  createError: string | null;
  canSubmit: boolean;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="px-2 pb-2" data-testid="app-files-create-form">
      <Input
        autoFocus
        aria-label={kind === 'file' ? 'New file name' : 'New folder name'}
        aria-invalid={validationError !== null || undefined}
        placeholder={kind === 'file' ? 'filename.txt' : 'folder-name'}
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSubmit) {
            onSubmit();
          }
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
      />
      <p
        className={chromeSansRole('caption') + ' pt-1 text-muted-foreground'}
        data-testid="app-files-create-destination"
      >
        In {relativeDir || 'Workspace root'}
        {name.trim() ? ` → ${destinationPath}` : ''}
      </p>
      {validationError !== null && (
        <p className={chromeSansRole('caption') + ' text-destructive'} data-testid="app-files-create-error">
          {validationError}
        </p>
      )}
      {createError !== null && (
        <p className={chromeSansRole('caption') + ' text-destructive'} data-testid="app-files-create-error">
          {createError}
        </p>
      )}
      <div className="flex gap-2 pt-2">
        <Button type="button" size="sm" disabled={!canSubmit} onClick={onSubmit}>
          Create
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AppFilesFolderSheet({
  open,
  onOpenChange,
  folderTitle,
  relativeDir,
  sessionId,
  fileOps,
  onRefresh,
  onCreatedFile,
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
        className="fixed top-auto bottom-0 left-0 max-h-[min(70dvh,24rem)] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-[var(--nession-radius-surface)] border-b-0 data-open:slide-in-from-bottom-4 data-closed:slide-out-to-bottom-4"
        data-testid="files-app-folder-sheet"
      >
        <DialogHeader>
          <DialogTitle>{folderTitle}</DialogTitle>
          <DialogDescription>Folder actions</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {open ? (
            <AppFilesCreateSection
              relativeDir={relativeDir}
              fileOps={fileOps}
              onDone={() => onOpenChange(false)}
              onRefresh={onRefresh}
              onCreatedFile={onCreatedFile}
            />
          ) : null}
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
