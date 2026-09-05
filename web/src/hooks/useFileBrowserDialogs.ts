import { useState } from 'react';
import type { FileEntry } from '@/features/files';

export function useFileBrowserDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  return {
    deleteTarget,
    setDeleteTarget,
  };
}
