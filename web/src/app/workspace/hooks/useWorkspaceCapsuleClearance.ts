import { useLayoutEffect, type RefObject } from 'react';
import { WORKSPACE_CONTENT_BOTTOM_INSET } from '@/shared/lib/workspaceScrollClearance';

/** The tool bar's contract with this hook — the element the zone draws itself into. */
const TOOL_BAR_SELECTOR = '[data-testid="workspace-tool-bar"]';

/**
 * Publishes {@link WORKSPACE_CONTENT_BOTTOM_INSET} on the Workspace shell from
 * the actual Capsule Zone geometry (#1347 SC-12).
 *
 * This is the Workspace's half of the mechanism `useCapsuleDockClearance`
 * provides for the Terminal, and the differences between the two are the
 * surfaces' own:
 *
 * - The Terminal spends the value *in layout* (the viewport shrinks and xterm
 *   re-fits), so the terminal's hook must measure the composer and ignore a
 *   floating projection (#826). The Workspace spends it as *trailing scroll
 *   padding*, so the honest number is the whole floating band — the tool bar's
 *   top to the shell's bottom — and an emerging capsule growing it is correct:
 *   scroll clearance costs no rows, it just moves the end of the scroll.
 * - The Workspace's bar is conditional (`showDock || showSurfaceAction`), so a
 *   missing bar publishes `0px` rather than keeping a stale measurement. The
 *   variable is removed on cleanup for the same reason: a shell that goes away
 *   must not leave a number behind for a container that now has nothing over it.
 *
 * The observer set covers the three ways the number moves: the shell resizes,
 * the bar resizes (the capsule's own content changes), and the bar mounts or
 * unmounts (capabilities change, a pushed depth hides the dock).
 */
export function useWorkspaceCapsuleClearance(shellRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    let observedBar: HTMLElement | null = null;

    const update = () => {
      const bar = shell.querySelector(TOOL_BAR_SELECTOR);
      const barElement = bar instanceof HTMLElement ? bar : null;
      if (barElement !== observedBar) {
        if (observedBar) {
          resizeObserver.unobserve(observedBar);
        }
        // Recorded before observing: an observer that invokes its callback
        // synchronously would otherwise re-enter with the stale value and
        // re-observe the same element forever.
        observedBar = barElement;
        if (barElement) {
          resizeObserver.observe(barElement);
        }
      }
      const inset = barElement
        ? Math.max(0, shell.getBoundingClientRect().bottom - barElement.getBoundingClientRect().top)
        : 0;
      shell.style.setProperty(WORKSPACE_CONTENT_BOTTOM_INSET, `${inset}px`);
    };

    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver(update);

    resizeObserver.observe(shell);
    mutationObserver.observe(shell, { childList: true, subtree: true });
    update();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      shell.style.removeProperty(WORKSPACE_CONTENT_BOTTOM_INSET);
    };
  }, [shellRef]);
}
