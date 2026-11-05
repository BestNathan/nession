import { useEffect, useRef, type RefObject } from 'react';
import type { TreeApi } from 'react-arborist';

import type { ArboristNode } from '../adapters/arboristAdapter';
import type { ExplorerStore } from '../ExplorerStore';

interface UseExplorerRevealPathOptions {
  store: ExplorerStore;
  treeRef: RefObject<TreeApi<ArboristNode> | undefined>;
  /** Any tree-data change; the reveal retries until its node has loaded. */
  treeData: unknown;
  initialPath?: string;
  revealPath?: string;
}

function revealPathInTree(
  path: string,
  store: ExplorerStore,
  treeRef: RefObject<TreeApi<ArboristNode> | undefined>,
): boolean {
  const snapshot = store.getSnapshot();
  if (!path) {
    if (snapshot.activeId !== null) {
      store.setActive(null);
    }
    return true;
  }

  const segments = path.split('/').filter(Boolean);
  let built = '';
  for (const segment of segments) {
    built = built ? `${built}/${segment}` : segment;
    if (!store.getNode(built)) {
      break;
    }
    if (!snapshot.expandedIds.has(built)) {
      store.expand(built);
    }
  }

  if (store.getNode(path)) {
    treeRef.current?.openParents(path);
    treeRef.current?.open(path);
    if (snapshot.activeId !== path) {
      store.setActive(path);
    }
    return true;
  }

  // The node is not in the store yet (its parent is still loading). Leave the
  // path unhandled so a later tree-data change can retry the reveal.
  return false;
}

/**
 * Reveal a path once per request.
 *
 * Reveal is a command, not a standing constraint. The effect also runs when
 * tree data changes (a load, a collapse, a rename); replaying the same reveal
 * there would undo the user's collapse and re-open the folder around the file
 * they just opened. Creation and explicit navigation change the requested path;
 * opening a file does not.
 */
export function useExplorerRevealPath({
  store,
  treeRef,
  treeData,
  initialPath,
  revealPath,
}: UseExplorerRevealPathOptions): void {
  const revealedPathRef = useRef<string | null>(null);

  useEffect(() => {
    const target = revealPath !== undefined ? revealPath : initialPath;
    if (target === undefined) {
      return;
    }
    if (revealedPathRef.current === target) {
      return;
    }
    if (revealPathInTree(target, store, treeRef)) {
      revealedPathRef.current = target;
    }
  }, [initialPath, revealPath, store, treeData, treeRef]);
}
