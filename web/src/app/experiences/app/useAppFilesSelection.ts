import { useCallback, useMemo, useState } from 'react';
import type { FileEntry } from '@/capabilities/files';

export function useAppFilesSelection() {
  const [active, setActive] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());

  const enterWith = useCallback((entry: FileEntry) => {
    setActive(true);
    setSelectedPaths(new Set([entry.path]));
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    setSelectedPaths(new Set());
  }, []);

  const toggle = useCallback((entry: FileEntry) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      if (next.size === 0) {
        setActive(false);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((entries: FileEntry[]) => {
    setActive(true);
    setSelectedPaths(new Set(entries.map((e) => e.path)));
  }, []);

  const count = selectedPaths.size;

  const isSelected = useCallback((path: string) => selectedPaths.has(path), [selectedPaths]);

  const selectedEntries = useCallback(
    (entries: FileEntry[]) => entries.filter((e) => selectedPaths.has(e.path)),
    [selectedPaths],
  );

  const summary = useMemo(() => `${count} selected`, [count]);

  return {
    active,
    count,
    summary,
    enterWith,
    exit,
    toggle,
    selectAll,
    isSelected,
    selectedEntries,
    selectedPaths,
  };
}

export type AppFilesSelection = ReturnType<typeof useAppFilesSelection>;
