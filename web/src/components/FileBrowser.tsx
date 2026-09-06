import {
  RefreshCw,
  FolderPlus,
  FilePlus,
  Upload,
  FolderUp,
  FolderSync,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useExplorerFileBrowser } from '../hooks/useExplorerFileBrowser';
import type { FileOps, FileEntry } from '@/features/files';
import { Explorer } from '@/explorer/Explorer';

export interface FileBrowserProps {
  fileOps: FileOps;
  onFileClick: (entry: FileEntry) => void;
  initialPath?: string;
  /** Called when a file/directory is deleted (so parent can close tabs) */
  onFileDeleted?: (path: string) => void;
  /** Called when a file/directory is renamed (so parent can update tabs) */
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  /** If provided, shows a button that queries the terminal's CWD and navigates there. */
  onGetTerminalPwd?: () => Promise<string>;
}

export function FileBrowser({
  fileOps,
  onFileClick,
  initialPath = '',
  onFileDeleted,
  onFileRenamed,
  onGetTerminalPwd,
}: FileBrowserProps) {
  const browser = useExplorerFileBrowser({
    fileOps,
    initialPath,
    onFileClick,
    onFileDeleted,
    onFileRenamed,
    onGetTerminalPwd,
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <FileToolbar
        loading={browser.loading}
        cwdLoading={browser.cwdLoading}
        onGoToParent={browser.handleGoToParent}
        parentDisabled={browser.parentDisabled}
        onRefresh={() => {
          void browser.handleRefresh();
        }}
        onNewFile={() => {
          browser.newEntryForm.setShowNewFile(true);
          browser.newEntryForm.setShowNewFolder(false);
        }}
        onNewFolder={() => {
          browser.newEntryForm.setShowNewFolder(true);
          browser.newEntryForm.setShowNewFile(false);
        }}
        onUploadClick={() => browser.fileInputRef.current?.click()}
        showCwdButton={browser.showCwdButton}
        onNavigateToCwd={() => {
          void browser.handleNavigateToCwd();
        }}
      />
      <input
        ref={browser.fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          void browser.handleUpload(e);
        }}
      />

      {(browser.newEntryForm.showNewFile || browser.newEntryForm.showNewFolder) && (
        <div className="flex items-center gap-1 px-2 py-1 border-b">
          <Input
            autoFocus
            placeholder={browser.newEntryForm.showNewFile ? 'filename.txt' : 'folder-name'}
            value={browser.newEntryForm.newName}
            onChange={(e) => browser.newEntryForm.setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (browser.newEntryForm.showNewFile) {
                  browser.handleCreateFile();
                } else {
                  browser.handleCreateFolder();
                }
              }
              if (e.key === 'Escape') {
                browser.newEntryForm.reset();
              }
            }}
            className="h-7 text-xs"
          />
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              if (browser.newEntryForm.showNewFile) {
                browser.handleCreateFile();
              } else {
                browser.handleCreateFolder();
              }
            }}
          >
            Create
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => browser.newEntryForm.reset()}
          >
            Cancel
          </Button>
        </div>
      )}

      <Explorer
        provider={browser.provider}
        onFileActivate={browser.handleFileActivate}
        onFileRenamed={browser.handleExplorerRenamed}
        onDeleteRequest={browser.handleDeleteRequest}
        revealPath={browser.currentPath}
        hideToolbar
        storeRef={browser.storeRef}
        className="flex-1 min-h-0"
      />

      <FileBrowserDeleteDialog
        deleteTarget={browser.dialogs.deleteTarget}
        onDeleteTargetChange={browser.dialogs.setDeleteTarget}
        onDeleteConfirm={() => {
          void browser.handleDeleteConfirm();
        }}
      />
    </div>
  );
}

interface FileBrowserDeleteDialogProps {
  deleteTarget: FileEntry | null;
  onDeleteTargetChange: (target: FileEntry | null) => void;
  onDeleteConfirm: () => void;
}

function FileBrowserDeleteDialog({
  deleteTarget,
  onDeleteTargetChange,
  onDeleteConfirm,
}: FileBrowserDeleteDialogProps) {
  return (
    <AlertDialog
      open={deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open) {
          onDeleteTargetChange(null);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {deleteTarget?.is_dir ? 'directory' : 'file'}?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteTarget?.is_dir
              ? `Delete directory "${deleteTarget?.name}" and everything inside it? This action cannot be undone.`
              : `Delete "${deleteTarget?.name}"? This action cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDeleteConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface FileToolbarProps {
  loading: boolean;
  cwdLoading: boolean;
  onGoToParent: () => void;
  parentDisabled: boolean;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUploadClick: () => void;
  showCwdButton: boolean;
  onNavigateToCwd: () => void;
}

function FileToolbar({
  loading,
  cwdLoading,
  onGoToParent,
  parentDisabled,
  onRefresh,
  onNewFile,
  onNewFolder,
  onUploadClick,
  showCwdButton,
  onNavigateToCwd,
}: FileToolbarProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border/60">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onGoToParent}
              disabled={parentDisabled}
              aria-label="Parent directory"
            />
          }
        >
          <FolderUp className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Parent directory</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh"
            />
          }
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Refresh</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onNewFile}
              aria-label="New file"
            />
          }
        >
          <FilePlus className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>New file</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onNewFolder}
              aria-label="New folder"
            />
          }
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>New folder</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={onUploadClick}
              aria-label="Upload file"
            />
          }
        >
          <Upload className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Upload file</p>
        </TooltipContent>
      </Tooltip>
      {showCwdButton && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={onNavigateToCwd}
                disabled={cwdLoading}
                aria-label="Go to terminal directory"
              />
            }
          >
            <FolderSync className={cn('h-3.5 w-3.5', cwdLoading && 'animate-spin')} />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Go to terminal directory</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
