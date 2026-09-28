import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import {
  directoryBreadcrumbSegments,
  directoryPathToStack,
  filesWorkspaceContextLine,
} from './appFilesNavigation';
import { useAppFilesPushedSurface } from './useAppFilesPushedSurface';
import { useAppFilesSearchDepth } from './useAppFilesSearchDepth';

export interface AppFilesNavigatorSession {
  sessionName?: string | null;
  agentLabel?: string | null;
}

export function useAppFilesNavigator(
  depth: WorkspaceDepthControl,
  session: AppFilesNavigatorSession,
  resetKey: unknown,
) {
  const [dirStack, setDirStack] = useState<string[]>(['']);
  const [selected, setSelected] = useState<{
    path: string;
    filename: string;
    size: number;
    initialLine?: number;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const scrollByPath = useRef(new Map<string, number>());
  const [restoredScrollTop, setRestoredScrollTop] = useState<number | undefined>(undefined);
  const { searchOpen, openSearch, closeSearch } = useAppFilesSearchDepth({
    dirStack,
    setDirStack,
    restoredScrollTop,
    setRestoredScrollTop,
    resetKey,
  });

  const currentDir = dirStack[dirStack.length - 1] ?? '';

  useEffect(() => {
    setDirStack(['']);
    setSelected(null);
    scrollByPath.current.clear();
  }, [resetKey]);

  const snapshotScroll = useCallback(
    (scrollTop: number) => {
      scrollByPath.current.set(currentDir, scrollTop);
    },
    [currentDir],
  );

  const popDirectory = useCallback(() => {
    if (dirStack.length <= 1) {
      return;
    }
    const parent = dirStack[dirStack.length - 2] ?? '';
    setRestoredScrollTop(scrollByPath.current.get(parent));
    setDirStack((stack) => stack.slice(0, -1));
  }, [dirStack]);

  const enterDirectory = useCallback((path: string) => {
    setRestoredScrollTop(undefined);
    setDirStack((stack) => [...stack, path]);
  }, []);

  const navigateToPath = useCallback((path: string) => {
    setRestoredScrollTop(scrollByPath.current.get(path));
    setDirStack(directoryPathToStack(path));
  }, []);

  useAppFilesPushedSurface(depth, {
    selected,
    searchOpen,
    dirStack,
    currentDir,
    dirty,
    closeSearch,
    setSelected,
    setShowDiscardDialog,
    popDirectory,
  });

  const workspaceContextLine = useMemo(
    () => filesWorkspaceContextLine(session),
    [session],
  );

  const breadcrumbSegments = useMemo(
    () => directoryBreadcrumbSegments(dirStack),
    [dirStack],
  );

  const openFile = useCallback(
    (
      entry: { path: string; name: string; size: number },
      options?: { initialLine?: number },
    ) => {
      setDirty(false);
      setShowDiscardDialog(false);
      if (searchOpen) {
        closeSearch();
      }
      setSelected({
        path: entry.path,
        filename: entry.name,
        size: entry.size,
        initialLine: options?.initialLine,
      });
    },
    [closeSearch, searchOpen],
  );

  const confirmDiscard = useCallback(() => {
    setShowDiscardDialog(false);
    setSelected(null);
  }, []);

  return {
    currentDir,
    selected,
    setDirty,
    showDiscardDialog,
    setShowDiscardDialog,
    restoredScrollTop,
    snapshotScroll,
    enterDirectory,
    navigateToPath,
    workspaceContextLine,
    breadcrumbSegments,
    openFile,
    confirmDiscard,
    searchOpen,
    openSearch,
    closeSearch,
  };
}
