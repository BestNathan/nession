import { useState, useCallback } from 'react';

/**
 * Group new file/folder form state.
 * Manages visibility of new file/folder inputs and the name field.
 */
export function useNewEntryForm() {
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState('');

  const reset = useCallback(() => {
    setShowNewFile(false);
    setShowNewFolder(false);
    setNewName('');
  }, []);

  return {
    showNewFile,
    showNewFolder,
    newName,
    setNewName,
    setShowNewFile,
    setShowNewFolder,
    reset,
  };
}
