import { useState, type RefObject } from 'react';
import { toast } from 'sonner';
import type { FileOps, FileEntry } from '@/capabilities/files';
import { copyToClipboard } from '@/shared/lib/clipboard';

export interface AppFilesSelectionApi {
  selectedEntries: (entries: FileEntry[]) => FileEntry[];
  exit: () => void;
  count: number;
}

export function useAppFilesBulkActions(
  fileOps: FileOps | null,
  selection: AppFilesSelectionApi,
  listEntriesRef: RefObject<FileEntry[]>,
  onListChanged: () => void,
) {
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleCopySelected = () => {
    const picked = selection.selectedEntries(listEntriesRef.current ?? []);
    const text = picked.map((e) => e.path).join('\n');
    if (!text) {
      return;
    }
    void copyToClipboard(text).then(
      () => {
        toast.success('Copied paths');
        selection.exit();
      },
      () => toast.error('Failed to copy'),
    );
  };

  const confirmDelete = () => {
    if (!fileOps) {
      return;
    }
    const picked = selection.selectedEntries(listEntriesRef.current ?? []);
    setDeleteOpen(false);
    void (async () => {
      try {
        for (const entry of picked) {
          await fileOps.deleteFile(entry.path, entry.is_dir);
        }
        toast.success(picked.length === 1 ? 'Deleted' : `Deleted ${picked.length} items`);
        selection.exit();
        onListChanged();
      } catch {
        toast.error('Could not delete');
      }
    })();
  };

  return {
    deleteOpen,
    setDeleteOpen,
    handleCopySelected,
    confirmDelete,
  };
}
