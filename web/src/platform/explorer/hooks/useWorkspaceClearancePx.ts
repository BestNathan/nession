import { useEffect, useState, type RefObject } from 'react';

import { WORKSPACE_CONTENT_BOTTOM_INSET } from '@/shared/lib/workspaceScrollClearance';

/**
 * The Workspace's published Capsule Zone clearance, in pixels (#1347 SC-12).
 *
 * `workspaceScrollClearanceClass` spends that variable as CSS trailing padding,
 * which a virtualized list cannot: react-arborist positions rows from numbers,
 * so the Explorer reads the same published value and hands it to the Tree's
 * `paddingBottom` — the virtualizer's own form of trailing scroll clearance.
 * Same owner, same measurement, same guarantee; only the unit differs.
 *
 * The Workspace Files navigator was the one scroll container the CSS class
 * could not reach when SC-12 landed, because its scroller belongs to the tree
 * library rather than to Nession's markup — measured on staging, where the
 * published inset was 68px and the tree had no clearance at all.
 *
 * Re-read on the shell's inline `style`, which is what
 * `useWorkspaceCapsuleClearance` writes. The value moves when the bar's height
 * or existence changes, and neither implies this container resizing — the bar
 * floats *over* it — so a ResizeObserver alone would miss every change.
 */
export function useWorkspaceClearancePx(ref: RefObject<HTMLElement | null>): number {
  const [clearance, setClearance] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const read = () => {
      const raw = getComputedStyle(el).getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET);
      const px = Number.parseFloat(raw) || 0;
      setClearance((current) => (current === px ? current : px));
    };

    read();

    const shell = el.closest('[data-testid="workspace-shell"]');
    if (!shell) {
      return;
    }
    const observer = new MutationObserver(read);
    observer.observe(shell, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [ref]);

  return clearance;
}
