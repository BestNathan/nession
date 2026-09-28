import { useCallback } from 'react';
import type { WorkspaceDepthControl } from '@/app/workspace/workspaceContext';
import { directoryPageTitle } from './appFilesNavigation';
import { useAppFilesShellPush } from './useAppFilesShellPush';

export function useAppFilesPushedSurface(
  depth: WorkspaceDepthControl,
  args: {
    selected: { filename: string } | null;
    searchOpen: boolean;
    dirStack: string[];
    currentDir: string;
    dirty: boolean;
    closeSearch: () => void;
    setSelected: (value: null) => void;
    setShowDiscardDialog: (open: boolean) => void;
    popDirectory: () => void;
  },
) {
  const {
    selected,
    searchOpen,
    dirStack,
    currentDir,
    dirty,
    closeSearch,
    setSelected,
    setShowDiscardDialog,
    popDirectory,
  } = args;

  const handleFileLeave = useCallback(() => {
    if (dirty) {
      setShowDiscardDialog(true);
      return;
    }
    setSelected(null);
  }, [dirty, setSelected, setShowDiscardDialog]);

  const handleDirectoryLeave = useCallback(() => {
    popDirectory();
  }, [popDirectory]);

  const pushedTitle = selected
    ? selected.filename
    : searchOpen
      ? 'Search'
      : dirStack.length > 1
        ? directoryPageTitle(currentDir)
        : null;
  const pushedLeave = selected
    ? handleFileLeave
    : searchOpen
      ? closeSearch
      : handleDirectoryLeave;

  useAppFilesShellPush(depth, pushedTitle, pushedLeave);
}
