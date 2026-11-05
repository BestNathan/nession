import { useCallback, useMemo, useState } from 'react';

import { toastError } from '@/shared/lib/errorHelpers';

import { renamedNodeId } from '../adapters/arboristAdapter';
import type { ExplorerStore } from '../ExplorerStore';
import type { ExplorerContextMenuContext } from '../commands/types';
import type { ExplorerDataProvider } from '../providers/types';
import type { ExplorerNode } from '../types';

interface UseExplorerFileActionsOptions {
  provider: ExplorerDataProvider;
  store: ExplorerStore;
  onFileDeleted?: (node: ExplorerNode) => void;
  onFileRenamed?: (node: ExplorerNode, newName: string) => void;
  /** When set, context-menu delete invokes this instead of deleting immediately. */
  onDeleteRequest?: (node: ExplorerNode) => void;
}

export function useExplorerFileActions({
  provider,
  store,
  onFileDeleted,
  onFileRenamed,
  onDeleteRequest,
}: UseExplorerFileActionsOptions) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleRenameCancel = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const handleRenameStart = useCallback((node: ExplorerNode) => {
    setRenamingId(node.id);
    setRenameValue(node.name);
  }, []);

  const handleRenameSubmit = useCallback(
    async (node: ExplorerNode) => {
      const trimmed = renameValue.trim();
      if (!trimmed || trimmed === node.name) {
        handleRenameCancel();
        return;
      }

      try {
        await provider.rename?.(node, trimmed);
        store.applyEvent({
          type: 'rename',
          nodeId: node.id,
          name: trimmed,
          newId: renamedNodeId(node, trimmed),
        });
        onFileRenamed?.(node, trimmed);
        handleRenameCancel();
      } catch (error) {
        // Keep the inline rename open so the name can be corrected; the
        // destination conflict is the provider's to report.
        toastError(error, 'Failed to rename');
      }
    },
    [handleRenameCancel, onFileRenamed, provider, renameValue, store],
  );

  const handleDelete = useCallback(
    async (node: ExplorerNode) => {
      try {
        await provider.delete?.(node);
        store.applyEvent({ type: 'delete', nodeId: node.id });
        onFileDeleted?.(node);
      } catch (error) {
        toastError(error, 'Failed to delete');
      }
    },
    [onFileDeleted, provider, store],
  );

  const menuContext = useMemo<ExplorerContextMenuContext>(
    () => ({
      onRename: handleRenameStart,
      onDelete: onDeleteRequest ?? ((node) => {
        void handleDelete(node);
      }),
    }),
    [handleDelete, handleRenameStart, onDeleteRequest],
  );

  return {
    renamingId,
    renameValue,
    setRenameValue,
    handleRenameCancel,
    handleRenameSubmit,
    menuContext,
  };
}
