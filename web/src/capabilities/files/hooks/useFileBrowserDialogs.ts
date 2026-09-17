import { useState } from 'react';
import type { FileEntry } from '@/capabilities/files';

export function useFileBrowserDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  return {
    deleteTarget,
    setDeleteTarget,
  };
}
