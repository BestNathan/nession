import { useState } from 'react';
import type { FileEntry } from '../services/fileOps';

export function useFileBrowserDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  return {
    deleteTarget,
    setDeleteTarget,
  };
}
