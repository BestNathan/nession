import { useState, useCallback } from 'react';

/**
 * Group rename operation state.
 * Manages which file is being renamed and the new name value.
 */
export function useRenameState() {
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = useCallback((path: string, currentName: string) => {
    setRenamingPath(path);
    setRenameValue(currentName);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
    setRenameValue('');
  }, []);

  return {
    renamingPath,
    renameValue,
    setRenameValue,
    startRename,
    cancelRename,
  };
}
