import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw,
  FolderPlus,
  FilePlus,
  Upload,
  Folder,
  File,
  ChevronRight,
  Home,
  Pencil,
  Trash2,
  FolderSync,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from './ui/context-menu';
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
import { formatSize, formatRelativeTimeSeconds } from '@/lib/format';
import { toastError } from '@/lib/errorHelpers';
import { useNewEntryForm } from '../hooks/useNewEntryForm';
import { useRenameState } from '../hooks/useRenameState';
import { useFileBrowserDialogs } from '../hooks/useFileBrowserDialogs';
import type { FileOps, FileEntry } from '../services/fileOps';

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

const MAX_SIZE_WARNING = 1 * 1024 * 1024; // 1 MB

type SortKey = 'name' | 'size' | 'modified';
type SortDir = 'asc' | 'desc';

export function FileBrowser({ fileOps, onFileClick, initialPath = '', onFileDeleted, onFileRenamed, onGetTerminalPwd }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newEntryForm = useNewEntryForm();
  const renameState = useRenameState();
  const dialogs = useFileBrowserDialogs();

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fileOps.listDir(path);
      setEntries(result.entries);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load directory';
      setError(msg);
      toastError(err, msg);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [fileOps]);

  useEffect(() => {
    loadDir(currentPath);
  }, [currentPath, loadDir]);
  const handleRefresh = () => loadDir(currentPath);
  const [cwdLoading, setCwdLoading] = useState(false);
  const handleNavigateToCwd = async () => {
    if (!onGetTerminalPwd) { return; }
    setCwdLoading(true);
    try { setCurrentPath(await onGetTerminalPwd()); } catch { toast.error('Failed to get terminal directory'); }
    finally { setCwdLoading(false); }
  };
  const handleEntryClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      setCurrentPath(entry.path);
    } else {
      if (entry.size > MAX_SIZE_WARNING) {
        dialogs.setLargeFileTarget(entry);
        return;
      }
      onFileClick(entry);
    }
  };

  const handleCreate = useCallback(async (name: string, kind: 'file' | 'folder') => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const path = currentPath ? `${currentPath}/${trimmed}` : trimmed;
    try {
      if (kind === 'file') {
        await fileOps.writeFile(path, '');
        toast.success(`Created ${trimmed}`);
      } else {
        await fileOps.createDir(path);
        toast.success(`Created ${trimmed}/`);
      }
      await loadDir(currentPath);
      newEntryForm.reset();
    } catch (err) {
      toastError(err, `Failed to create ${kind}`);
    }
  }, [currentPath, fileOps, loadDir, newEntryForm]);

  const handleCreateFile = useCallback(() => {
    handleCreate(newEntryForm.newName, 'file');
  }, [handleCreate, newEntryForm.newName]);

  const handleCreateFolder = useCallback(() => {
    handleCreate(newEntryForm.newName, 'folder');
  }, [handleCreate, newEntryForm.newName]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {return;}
    const fullPath = currentPath ? `${currentPath}/${file.name}` : file.name;
    try {
      await fileOps.uploadFile(fullPath, file);
      toast.success(`Uploaded ${file.name}`);
      loadDir(currentPath);
    } catch (err) {
      toastError(err, 'Failed to upload file');
    }
    e.target.value = '';
  };

  const handleRenameStart = (entry: FileEntry) => {
    renameState.startRename(entry.path, entry.name);
  };

  const handleRenameSubmit = async () => {
    const name = renameState.renameValue.trim();
    if (!name) {
      toast.error('Name cannot be empty');
      return;
    }
    if (!renameState.renamingPath) {return;}

    const oldName = renameState.renamingPath.substring(renameState.renamingPath.lastIndexOf('/') + 1);
    if (name === oldName) {
      renameState.cancelRename();
      return;
    }

    const parentPath = renameState.renamingPath.substring(0, renameState.renamingPath.lastIndexOf('/'));
    const newPath = parentPath ? `${parentPath}/${name}` : name;

    try {
      await fileOps.renameFile(renameState.renamingPath, newPath);
      toast.success(`Renamed to ${name}`);
      onFileRenamed?.(renameState.renamingPath, newPath);
      renameState.cancelRename();
      loadDir(currentPath);
    } catch (err) {
      toastError(err, 'Failed to rename');
    }
  };

  const handleRenameCancel = () => {
    renameState.cancelRename();
  };

  const handleDelete = async (entry: FileEntry) => {
    dialogs.setDeleteTarget(entry);
  };

  const handleDeleteConfirm = async () => {
    if (!dialogs.deleteTarget) {return;}
    const entry = dialogs.deleteTarget;
    dialogs.setDeleteTarget(null);

    try {
      await fileOps.deleteFile(entry.path);
      toast.success(`Deleted ${entry.name}`);
      onFileDeleted?.(entry.path);
      loadDir(currentPath);
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('not empty')) {
        toast.error('Cannot delete non-empty directory');
      } else {
        toastError(err, 'Failed to delete');
      }
    }
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortedEntries = [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) {return a.is_dir ? -1 : 1;}
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'name') {return dir * a.name.toLowerCase().localeCompare(b.name.toLowerCase());}
    if (sortKey === 'size') {return dir * (a.size - b.size);}
    if (sortKey === 'modified') {return dir * (a.modified - b.modified);}
    return 0;
  });

  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b flex-wrap">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleRefresh} disabled={loading} title="Refresh">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { newEntryForm.setShowNewFile(true); newEntryForm.setShowNewFolder(false); }} title="New file">
          <FilePlus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { newEntryForm.setShowNewFolder(true); newEntryForm.setShowNewFile(false); }} title="New folder">
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fileInputRef.current?.click()} title="Upload file">
          <Upload className="h-3.5 w-3.5" />
        </Button>
        {onGetTerminalPwd && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleNavigateToCwd} disabled={cwdLoading} title="Go to terminal directory">
            <FolderSync className={cn('h-3.5 w-3.5', cwdLoading && 'animate-spin')} />
          </Button>
        )}
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
      </div>

      {/* New file/folder input */}
      {(newEntryForm.showNewFile || newEntryForm.showNewFolder) && (
        <div className="flex items-center gap-1 px-2 py-1 border-b">
          <Input
            autoFocus
            placeholder={newEntryForm.showNewFile ? 'filename.txt' : 'folder-name'}
            value={newEntryForm.newName}
            onChange={(e) => newEntryForm.setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (newEntryForm.showNewFile) {handleCreateFile();} else {handleCreateFolder();}
              }
              if (e.key === 'Escape') { newEntryForm.reset(); }
            }}
            className="h-7 text-xs"
          />
          <Button size="sm" className="h-7 text-xs" onClick={newEntryForm.showNewFile ? handleCreateFile : handleCreateFolder}>Create</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => newEntryForm.reset()}>Cancel</Button>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground overflow-x-auto flex-shrink-0 border-b">
        <button onClick={() => setCurrentPath('')} className="hover:text-foreground transition-colors flex items-center gap-0.5 flex-shrink-0" title="Root">
          <Home className="h-3 w-3" />
        </button>
        {segments.map((seg, i) => {
          const path = segments.slice(0, i + 1).join('/');
          return (
            <span key={path} className="flex items-center gap-0.5 flex-shrink-0">
              <ChevronRight className="h-3 w-3" />
              <button onClick={() => setCurrentPath(path)} className="hover:text-foreground transition-colors truncate max-w-[100px]">
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {/* Column headers */}
      <div className="flex items-center px-2 py-0.5 text-[10px] text-muted-foreground border-b select-none">
        {(['name', 'size', 'modified'] as const).map((key) => (
          <button key={key} className={key === 'name' ? 'flex-1 text-left' : 'w-16 text-right'} onClick={() => handleSort(key)}>
            {key === 'name' ? 'Name' : key === 'size' ? 'Size' : 'Mod'}{sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>))}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-2 space-y-1">
            {[1, 2, 3, 4, 5].map((i) => (<Skeleton key={i} className="h-6 w-full" />))}
          </div>
        ) : error ? (
          <div className="p-3 text-center text-sm text-muted-foreground">
            <p className="text-destructive mb-1">Failed to load directory</p>
            <Button variant="outline" size="sm" onClick={handleRefresh}>Retry</Button>
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="p-3 text-center text-sm text-muted-foreground">This directory is empty</div>
        ) : (
          sortedEntries.map((entry) =>
            renameState.renamingPath === entry.path ? (
              <div key={entry.path} className="flex items-center gap-1 w-full px-2 py-0.5">
                {entry.is_dir ? (
                  <Folder className="h-3.5 w-3.5 mr-1 text-blue-400 flex-shrink-0" />
                ) : (
                  <File className="h-3.5 w-3.5 mr-1 text-muted-foreground flex-shrink-0" />
                )}
                <Input
                  autoFocus
                  value={renameState.renameValue}
                  onChange={(e) => renameState.setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {handleRenameSubmit();}
                    if (e.key === 'Escape') {handleRenameCancel();}
                  }}
                  className="h-6 text-xs flex-1"
                />
                <Button size="sm" className="h-6 text-xs" onClick={handleRenameSubmit}>Rename</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={handleRenameCancel}>Cancel</Button>
              </div>
            ) : (
              <ContextMenu key={entry.path}>
                <ContextMenuTrigger
                  onClick={() => handleEntryClick(entry)}
                  className="flex items-center w-full px-2 py-0.5 text-xs hover:bg-accent transition-colors text-left cursor-default"
                >
                  {entry.is_dir ? (
                    <Folder className="h-3.5 w-3.5 mr-1.5 text-blue-400 flex-shrink-0" />
                  ) : (
                    <File className="h-3.5 w-3.5 mr-1.5 text-muted-foreground flex-shrink-0" />
                  )}
                  <span className="flex-1 truncate">{entry.name}</span>
                  <span className="w-16 text-right text-muted-foreground flex-shrink-0">{entry.is_dir ? '' : formatSize(entry.size)}</span>
                  <span className="w-16 text-right text-muted-foreground flex-shrink-0">{formatRelativeTimeSeconds(entry.modified)}</span>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-36">
                  <ContextMenuItem onClick={() => handleRenameStart(entry)}>
                    <Pencil /> Rename
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => handleDelete(entry)}>
                    <Trash2 /> Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ),
          )
        )}
      </div>

      <FileBrowserDialogs
        deleteTarget={dialogs.deleteTarget}
        largeFileTarget={dialogs.largeFileTarget}
        onDeleteTargetChange={dialogs.setDeleteTarget}
        onLargeFileTargetChange={dialogs.setLargeFileTarget}
        onDeleteConfirm={handleDeleteConfirm}
        onFileClick={onFileClick}
      />
    </div>
  );
}

interface FileBrowserDialogsProps {
  deleteTarget: FileEntry | null;
  largeFileTarget: FileEntry | null;
  onDeleteTargetChange: (target: FileEntry | null) => void;
  onLargeFileTargetChange: (target: FileEntry | null) => void;
  onDeleteConfirm: () => void;
  onFileClick: (entry: FileEntry) => void;
}

function FileBrowserDialogs({
  deleteTarget,
  largeFileTarget,
  onDeleteTargetChange,
  onLargeFileTargetChange,
  onDeleteConfirm,
  onFileClick,
}: FileBrowserDialogsProps) {
  return (
    <>
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { onDeleteTargetChange(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.is_dir ? 'directory' : 'file'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {deleteTarget?.is_dir ? `directory "${deleteTarget?.name}"` : `"${deleteTarget?.name}"`}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={largeFileTarget !== null} onOpenChange={(open) => { if (!open) { onLargeFileTargetChange(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Large file warning</AlertDialogTitle>
            <AlertDialogDescription>
              This file is {largeFileTarget ? formatSize(largeFileTarget.size) : ''}. Loading large files may be slow. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (largeFileTarget) { onFileClick(largeFileTarget); } onLargeFileTargetChange(null); }}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
