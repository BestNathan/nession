import { useCallback, useEffect, useRef, useState } from 'react';

interface AppFilesSearchDepthOptions {
  dirStack: string[];
  setDirStack: (stack: string[]) => void;
  restoredScrollTop: number | undefined;
  setRestoredScrollTop: (value: number | undefined) => void;
  resetKey: unknown;
}

/** Search overlay state — restores directory navigation on leave (#1140). */
export function useAppFilesSearchDepth({
  dirStack,
  setDirStack,
  restoredScrollTop,
  setRestoredScrollTop,
  resetKey,
}: AppFilesSearchDepthOptions) {
  const [searchOpen, setSearchOpen] = useState(false);
  const navSnapshotRef = useRef<{ dirStack: string[]; restoredScrollTop: number | undefined } | null>(
    null,
  );

  useEffect(() => {
    setSearchOpen(false);
    navSnapshotRef.current = null;
  }, [resetKey]);

  const closeSearch = useCallback(() => {
    const snapshot = navSnapshotRef.current;
    navSnapshotRef.current = null;
    setSearchOpen(false);
    if (snapshot) {
      setDirStack(snapshot.dirStack);
      setRestoredScrollTop(snapshot.restoredScrollTop);
    }
  }, [setDirStack, setRestoredScrollTop]);

  const openSearch = useCallback(() => {
    navSnapshotRef.current = { dirStack: [...dirStack], restoredScrollTop };
    setSearchOpen(true);
  }, [dirStack, restoredScrollTop]);

  return { searchOpen, openSearch, closeSearch };
}
