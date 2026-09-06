import { useCallback, useMemo, useRef, useState, type ChangeEvent, type MutableRefObject } from 'react';
import { toast } from 'sonner';

import type { FileOps, FileEntry } from '@/features/files';
import { ExplorerStore, ROOT_ID } from '@/explorer/ExplorerStore';
import { createNessionFileSystemProvider } from '@/explorer/providers/NessionFileSystemProvider';
import type { ExplorerDataProvider } from '@/explorer/providers/types';
import type { ExplorerNode } from '@/explorer/types';
import { registerSeenLangKeys, scanLangKeysFromPaths } from '@/lib/codeMirrorLangs';
import { toastError } from '@/lib/errorHelpers';

import { useFileBrowserDialogs } from './useFileBrowserDialogs';
import { useNewEntryForm } from './useNewEntryForm';

const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024;
const MAX_BINARY_FILE_SIZE = 10 * 1024 * 1024;

export function explorerNodeToFileEntry(node: ExplorerNode): FileEntry {
  return {
    name: node.name,
    path: node.uri,
    full_path: node.metadata?.fullPath ?? node.uri,
    is_dir: node.kind === 'directory',
    size: node.metadata?.size ?? 0,
    modified: node.metadata?.modifiedAt ?? 0,
    is_binary: node.metadata?.isBinary,
  };
}

export function createLangAwareFileSystemProvider(fileOps: FileOps): ExplorerDataProvider {
  const base = createNessionFileSystemProvider(fileOps);
  return {
    ...base,
    async loadChildren(node) {
      const children = await base.loadChildren(node);
      const langKeys = scanLangKeysFromPaths(children.map((child) => child.uri));
      if (langKeys.length > 0) {
        registerSeenLangKeys(langKeys);
      }
      return children;
    },
  };
}

export interface UseExplorerFileBrowserOptions {
  fileOps: FileOps;
  initialPath?: string;
  onFileClick: (entry: FileEntry) => void;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onGetTerminalPwd?: () => Promise<string>;
}

function useExplorerFileBrowserNavigation(
  initialPath: string,
  onGetTerminalPwd: (() => Promise<string>) | undefined,
  storeRef: MutableRefObject<ExplorerStore | null>,
) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [loading, setLoading] = useState(false);
  const [cwdLoading, setCwdLoading] = useState(false);

  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];
  const parentDisabled = segments.length === 0;

  const handleGoToParent = useCallback(() => {
    const parts = currentPath.split('/').filter(Boolean);
    setCurrentPath(parts.slice(0, -1).join('/'));
  }, [currentPath]);

  const handleRefresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) {
      return;
    }
    setLoading(true);
    try {
      await store.refresh(currentPath || ROOT_ID);
    } finally {
      setLoading(false);
    }
  }, [currentPath, storeRef]);

  const handleNavigateToCwd = useCallback(async () => {
    if (!onGetTerminalPwd) {
      return;
    }
    setCwdLoading(true);
    try {
      setCurrentPath(await onGetTerminalPwd());
    } catch {
      toast.error('Failed to get terminal directory');
    } finally {
      setCwdLoading(false);
    }
  }, [onGetTerminalPwd]);

  const handleDirectoryActivate = useCallback((node: ExplorerNode) => {
    setCurrentPath(node.uri);
  }, []);

  return {
    currentPath,
    loading,
    cwdLoading,
    parentDisabled,
    handleGoToParent,
    handleRefresh,
    handleNavigateToCwd,
    handleDirectoryActivate,
  };
}

function useExplorerFileBrowserMutations({
  fileOps,
  currentPath,
  storeRef,
  newEntryForm,
  dialogs,
  onFileDeleted,
  onFileRenamed,
}: {
  fileOps: FileOps;
  currentPath: string;
  storeRef: MutableRefObject<ExplorerStore | null>;
  newEntryForm: ReturnType<typeof useNewEntryForm>;
  dialogs: ReturnType<typeof useFileBrowserDialogs>;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
}) {
  const handleCreate = useCallback(
    async (name: string, kind: 'file' | 'folder') => {
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
        await storeRef.current?.refresh(currentPath || ROOT_ID);
        newEntryForm.reset();
      } catch (err) {
        toastError(err, `Failed to create ${kind}`);
      }
    },
    [currentPath, fileOps, newEntryForm, storeRef],
  );

  const handleCreateFile = useCallback(() => {
    void handleCreate(newEntryForm.newName, 'file');
  }, [handleCreate, newEntryForm.newName]);

  const handleCreateFolder = useCallback(() => {
    void handleCreate(newEntryForm.newName, 'folder');
  }, [handleCreate, newEntryForm.newName]);

  const handleUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }
      const fullPath = currentPath ? `${currentPath}/${file.name}` : file.name;
      try {
        await fileOps.uploadFile(fullPath, file);
        toast.success(`Uploaded ${file.name}`);
        await storeRef.current?.refresh(currentPath || ROOT_ID);
      } catch (err) {
        toastError(err, 'Failed to upload file');
      }
      e.target.value = '';
    },
    [currentPath, fileOps, storeRef],
  );

  const handleDeleteRequest = useCallback(
    (node: ExplorerNode) => {
      dialogs.setDeleteTarget(explorerNodeToFileEntry(node));
    },
    [dialogs],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!dialogs.deleteTarget) {
      return;
    }
    const entry = dialogs.deleteTarget;
    dialogs.setDeleteTarget(null);

    try {
      await fileOps.deleteFile(entry.path, entry.is_dir);
      toast.success(`Deleted ${entry.name}`);
      onFileDeleted?.(entry.path);
      storeRef.current?.applyEvent({ type: 'delete', nodeId: entry.path });
    } catch (err) {
      toastError(err, 'Failed to delete');
    }
  }, [dialogs, fileOps, onFileDeleted, storeRef]);

  const handleExplorerRenamed = useCallback(
    (node: ExplorerNode, newName: string) => {
      const lastSlash = node.uri.lastIndexOf('/');
      const parentPath = lastSlash >= 0 ? node.uri.slice(0, lastSlash) : '';
      const newPath = parentPath ? `${parentPath}/${newName}` : newName;
      onFileRenamed?.(node.uri, newPath);
    },
    [onFileRenamed],
  );

  return {
    handleCreateFile,
    handleCreateFolder,
    handleUpload,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleExplorerRenamed,
  };
}

export function useExplorerFileBrowser({
  fileOps,
  initialPath = '',
  onFileClick,
  onFileDeleted,
  onFileRenamed,
  onGetTerminalPwd,
}: UseExplorerFileBrowserOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const storeRef = useRef<ExplorerStore | null>(null);
  const newEntryForm = useNewEntryForm();
  const dialogs = useFileBrowserDialogs();

  const provider = useMemo(() => createLangAwareFileSystemProvider(fileOps), [fileOps]);

  const navigation = useExplorerFileBrowserNavigation(initialPath, onGetTerminalPwd, storeRef);
  const mutations = useExplorerFileBrowserMutations({
    fileOps,
    currentPath: navigation.currentPath,
    storeRef,
    newEntryForm,
    dialogs,
    onFileDeleted,
    onFileRenamed,
  });

  const handleFileActivate = useCallback(
    (node: ExplorerNode) => {
      if (node.kind === 'directory') {
        navigation.handleDirectoryActivate(node);
        return;
      }

      const entry = explorerNodeToFileEntry(node);
      const isBinary = entry.is_binary ?? false;
      const maxSize = isBinary ? MAX_BINARY_FILE_SIZE : MAX_TEXT_FILE_SIZE;
      if (entry.size > maxSize) {
        const label = isBinary ? 'Binary file' : 'File';
        toast.error(`${label} too large for preview (>${maxSize / 1024 / 1024}MB)`);
        return;
      }
      onFileClick(entry);
    },
    [navigation, onFileClick],
  );

  return {
    provider,
    fileInputRef,
    storeRef,
    newEntryForm,
    dialogs,
    handleFileActivate,
    showCwdButton: Boolean(onGetTerminalPwd),
    ...navigation,
    ...mutations,
  };
}
