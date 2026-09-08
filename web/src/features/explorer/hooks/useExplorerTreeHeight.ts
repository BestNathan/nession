import { useEffect, useState, type RefObject } from 'react';

import {
  DEFAULT_TREE_HEIGHT,
  measureExplorerTreeHeight,
} from '../adapters/arboristAdapter';

export function useExplorerTreeHeight(containerRef: RefObject<HTMLDivElement | null>): number {
  const [treeHeight, setTreeHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }

    const updateHeight = () => {
      const measured = measureExplorerTreeHeight(el);
      if (measured !== null) {
        setTreeHeight(measured);
      }
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    if (el.parentElement) {
      observer.observe(el.parentElement);
    }
    return () => observer.disconnect();
  }, [containerRef]);

  return treeHeight > 0 ? treeHeight : DEFAULT_TREE_HEIGHT;
}
