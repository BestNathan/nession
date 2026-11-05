import { useCallback, useMemo, useRef, useState, type ChangeEvent, type MutableRefObject } from 'react';
import { toast } from 'sonner';

import type { FileOps, FileEntry } from '@/capabilities/files';
import { ExplorerStore, ROOT_ID } from '@/platform/explorer/ExplorerStore';
import { createNessionFileSystemProvider } from '@/capabilities/files/adapters/NessionFileSystemProvider';
import type { ExplorerDataProvider } from '@/platform/explorer/providers/types';
import type { ExplorerNode } from '@/platform/explorer/types';
import { registerSeenLanguageIds, scanLanguageIdsFromPaths } from '@/platform/editor';
import { toastError } from '@/shared/lib/errorHelpers';

import {
  joinPath,
  resolveCreateTarget,
  type CreateKind,
} from '../model/createTarget';
import { fileErrorMessage } from '../model/fileErrors';
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
      const languageIds = scanLanguageIdsFromPaths(children.map((child) => child.uri));
      if (languageIds.length > 0) {
        registerSeenLanguageIds(languageIds);
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

function resolveCurrentParent(
  store: ExplorerStore | null,
  currentPath: string,
  contextTarget?: ExplorerNode | null,
): string {
  const snapshot = store?.getSnapshot();
  const selected = snapshot
    ? [...snapshot.selectedIds]
        .map((id) => store?.getNode(id))
        .filter((node): node is ExplorerNode => node !== undefined)
    : [];
  const active = snapshot?.activeId ? (store?.getNode(snapshot.activeId) ?? null) : null;
  return resolveCreateTarget({
    selected,
    active,
    currentPath,
    contextTarget: contextTarget ?? null,
  }).parentPath;
}

/**
 * Upload lifecycle: capture the destination when the picker opens, then write
 * the chosen file there. `uploadFile` defaults to create-only, so an upload
 * cannot replace a same-named Workspace file.
 */
function useExplorerUpload({
  fileOps,
  currentPath,
  storeRef,
  onReveal,
}: {
  fileOps: FileOps;
  currentPath: string;
  storeRef: MutableRefObject<ExplorerStore | null>;
  onReveal: (path: string) => void;
}) {
  const uploadTargetRef = useRef<string | null>(null);

  const beginUpload = useCallback(() => {
    uploadTargetRef.current = resolveCurrentParent(storeRef.current, currentPath);
  }, [currentPath, storeRef]);

  const handleUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }
      const parentPath = uploadTargetRef.current ?? currentPath;
      const fullPath = joinPath(parentPath, file.name);
      try {
        await fileOps.uploadFile(fullPath, file);
        toast.success(`Uploaded ${file.name}`);
        await storeRef.current?.refresh(parentPath || ROOT_ID);
        onReveal(fullPath);
      } catch (err) {
        toast.error(fileErrorMessage(err, 'upload file'));
      }
      e.target.value = '';
      uploadTargetRef.current = null;
    },
    [currentPath, fileOps, onReveal, storeRef],
  );

  return { beginUpload, handleUpload };
}

function useExplorerFileBrowserMutations({
  fileOps,
  currentPath,
  storeRef,
  newEntryForm,
  dialogs,
  onFileDeleted,
  onFileRenamed,
  onReveal,
}: {
  fileOps: FileOps;
  currentPath: string;
  storeRef: MutableRefObject<ExplorerStore | null>;
  newEntryForm: ReturnType<typeof useNewEntryForm>;
  dialogs: ReturnType<typeof useFileBrowserDialogs>;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onReveal: (path: string) => void;
}) {
  const upload = useExplorerUpload({ fileOps, currentPath, storeRef, onReveal });

  const handleCreate = useCallback(async () => {
    const target = newEntryForm.target;
    if (!target || newEntryForm.validationError !== null) {
      return;
    }
    const name = newEntryForm.newName.trim();
    if (!name) {
      return;
    }

    const path = joinPath(target.parentPath, name);
    try {
      if (target.kind === 'file') {
        await fileOps.writeFile(path, '', { createOnly: true });
        toast.success(`Created ${name}`);
      } else {
        await fileOps.createDir(path, { createOnly: true });
        toast.success(`Created ${name}/`);
      }
      await storeRef.current?.refresh(target.parentPath || ROOT_ID);
      newEntryForm.reset();
      onReveal(path);
    } catch (err) {
      // Keep the form and its contents: the user corrects the name and resubmits.
      newEntryForm.setSubmitError(
        fileErrorMessage(err, target.kind === 'file' ? 'create file' : 'create folder'),
      );
    }
  }, [fileOps, newEntryForm, onReveal, storeRef]);

  const handleCreateFile = useCallback(() => {
    void handleCreate();
  }, [handleCreate]);

  const handleCreateFolder = useCallback(() => {
    void handleCreate();
  }, [handleCreate]);

  /** Capture the creation destination, then open the form. */
  const openCreate = useCallback(
    (kind: CreateKind, contextTarget?: ExplorerNode | null) => {
      newEntryForm.open(
        kind,
        resolveCurrentParent(storeRef.current, currentPath, contextTarget),
      );
    },
    [currentPath, newEntryForm, storeRef],
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
    handleCreate,
    handleCreateFile,
    handleCreateFolder,
    openCreate,
    ...upload,
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

  const [revealPath, setRevealPath] = useState(initialPath);
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
    onReveal: setRevealPath,
  });

  const handleFileActivate = useCallback(
    (node: ExplorerNode) => {
      // Activation opens/selects; it is not a reveal request. Reveal belongs to
      // creation and explicit navigation, so collapsing a folder is never
      // undone by the file the user opened inside it.
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
    revealPath,
    showCwdButton: Boolean(onGetTerminalPwd),
    ...navigation,
    ...mutations,
  };
}
