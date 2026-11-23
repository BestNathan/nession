import { useCallback, type RefObject } from 'react';
import type { ShellBounds } from './edgeBand';

/**
 * Read the App shell's horizontal extent at touch time (#1081).
 *
 * Deliberately a callback, not a cached value: the shell can move and resize,
 * and an inset App must put its edge band where the user sees it. `null` means
 * the shell cannot say where its edges are, so a touch inside a work surface
 * does not start a page.
 */
export function useShellBounds(rootRef: RefObject<HTMLElement | null>): () => ShellBounds | null {
  return useCallback(() => {
    const el = rootRef.current;
    if (!el) {
      return null;
    }
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  }, [rootRef]);
}
