import { useState } from 'react';
import type { FileEntry } from '../services/fileOps';

/**
 * Group dialog target state for FileBrowser.
 * Manages delete confirmation and large file warning dialogs.
 */
export function useFileBrowserDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [largeFileTarget, setLargeFileTarget] = useState<FileEntry | null>(null);

  return {
    deleteTarget,
    largeFileTarget,
    setDeleteTarget,
    setLargeFileTarget,
  };
}
