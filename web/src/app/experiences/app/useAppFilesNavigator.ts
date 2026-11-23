import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import {
  directoryBreadcrumbSegments,
  directoryPathToStack,
  filesWorkspaceContextLine,
} from './appFilesNavigation';
import { useAppFilesLeaveGuard, type AppFilesSelection } from './useAppFilesLeaveGuard';
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
  sourceId: string,
) {
  const [dirStack, setDirStack] = useState<string[]>(['']);
  const [selected, setSelected] = useState<AppFilesSelection | null>(null);
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

  const { requestLeave, confirmDiscard, clearForward } = useAppFilesLeaveGuard({
    depth,
    selected,
    setSelected,
    dirty,
    setDirty,
    setShowDiscardDialog,
  });

  useEffect(() => {
    setDirStack(['']);
    setSelected(null);
    clearForward();
    scrollByPath.current.clear();
  }, [clearForward, resetKey, sourceId]);

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
    clearForward();
    const parent = dirStack[dirStack.length - 2] ?? '';
    setRestoredScrollTop(scrollByPath.current.get(parent));
    setDirStack((stack) => stack.slice(0, -1));
  }, [clearForward, dirStack]);

  const enterDirectory = useCallback((path: string) => {
    clearForward();
    setRestoredScrollTop(undefined);
    setDirStack((stack) => [...stack, path]);
  }, [clearForward]);

  const navigateToPath = useCallback((path: string) => {
    clearForward();
    setRestoredScrollTop(scrollByPath.current.get(path));
    setDirStack(directoryPathToStack(path));
  }, [clearForward]);

  useAppFilesPushedSurface(depth, {
    selected,
    searchOpen,
    dirStack,
    currentDir,
    requestLeave,
    closeSearch,
    popDirectory,
    navigateToPath,
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
      options?: { initialLine?: number; initialColumn?: number },
    ) => {
      setDirty(false);
      setShowDiscardDialog(false);
      clearForward();
      if (searchOpen) {
        closeSearch();
      }
      setSelected({
        ref: { sourceId, path: entry.path },
        path: entry.path,
        filename: entry.name,
        size: entry.size,
        initialLine: options?.initialLine,
        initialColumn: options?.initialColumn,
      });
    },
    [clearForward, closeSearch, searchOpen, sourceId],
  );

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
    requestLeave,
    confirmDiscard,
    searchOpen,
    openSearch,
    closeSearch,
  };
}
