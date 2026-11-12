import { useEffect, useRef, type RefObject } from 'react';
import type { TreeApi } from 'react-arborist';
import type { ArboristNode } from '../adapters/arboristAdapter';
import type { ExplorerStore } from '../ExplorerStore';

/**
 * Keep the tree row on the host's open file.
 *
 * The host may reject an activation (a dirty-file navigation guard) and may
 * later commit the switch from its own decision. `selectedPath` is therefore
 * the host's truth, not a second tree cursor: this effect moves the row only
 * when the host's value changes and its node is loaded. It deliberately does
 * not react to every tree-data change, because selecting a directory for a
 * create target is still a legitimate transient row selection.
 */
export function useExplorerControlledSelection({
  store,
  treeRef,
  treeData,
  selectedPath,
  selectionRevision = 0,
}: {
  store: ExplorerStore;
  treeRef: RefObject<TreeApi<ArboristNode> | undefined>;
  treeData: unknown;
  selectedPath?: string | null;
  /** Bumped when the host rejects an activation and the row must be reasserted. */
  selectionRevision?: number;
}): void {
  const appliedRef = useRef<string>('');

  useEffect(() => {
    if (selectedPath === undefined) {
      return;
    }
    const tree = treeRef.current;
    if (!tree) {
      return;
    }
    if (selectedPath !== null && !store.getNode(selectedPath)) {
      return;
    }
    const appliedKey = `${selectedPath ?? 'none'}|${selectionRevision}`;
    if (appliedRef.current === appliedKey) {
      return;
    }
    if (selectedPath === null) {
      tree.deselectAll();
      store.setSelection([]);
      store.setActive(null);
    } else {
      tree.select(selectedPath);
      store.setSelection([selectedPath]);
      store.setActive(selectedPath);
    }
    appliedRef.current = appliedKey;
  }, [selectedPath, selectionRevision, store, treeData, treeRef]);
}
