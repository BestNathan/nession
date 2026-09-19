import { useLayoutEffect, type RefObject } from 'react';
import { TERMINAL_CAPSULE_OCCLUSION_EVENT } from '@/platform/terminal-runtime/capsule/occlusionScroll';

/**
 * Publishes `--terminal-capsule-occlusion` on the nearest
 * `[data-terminal-capsule-host]`.
 *
 * That value is not advisory: `--terminal-content-bottom-inset` derives from it
 * and `TerminalViewport` spends it as `padding-bottom`, inside a `box-border`
 * element xterm is mounted in. So whatever this measures is height the terminal
 * genuinely loses, and it re-fits — rows change — every time the number moves.
 *
 * ## Why it measures the shell, not the dock
 *
 * The dock is the capsule's whole floating column, and since #826 that column
 * also carries a capability Signal or Peek when one has emerged. Measured on
 * the dock, a Signal added its own height to the occlusion, so the terminal
 * would shrink by ~120px while the Signal was up and grow back when it was
 * dismissed — a temporary, subordinate surface reflowing the work surface,
 * which is the one thing `capability-emergence.md` says a projection must not
 * do.
 *
 * The shell is the composer. The dock is bottom-anchored and lays out as a
 * column, so the shell's top is fixed no matter what floats above it: measured
 * at 390×844, `shell.top` was 368 both with and without a projection, and the
 * inset is the same number either way. Reserve for the composer, and let a
 * projection pass over the scrollback the way a popover does.
 */
export function useCapsuleDockClearance(shellRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const host = shell.closest('[data-terminal-capsule-host]');
    if (!(host instanceof HTMLElement)) {
      return;
    }

    const update = () => {
      const hostRect = host.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const gapRaw = getComputedStyle(host).getPropertyValue('--terminal-capsule-terminal-clearance-gap');
      const gap = Number.parseFloat(gapRaw) || 0;
      const clearance = Math.max(0, hostRect.bottom - shellRect.top + gap);
      host.style.setProperty('--terminal-capsule-occlusion', `${clearance}px`);
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_OCCLUSION_EVENT));
    };

    const observer = new ResizeObserver(update);
    observer.observe(shell);
    observer.observe(host);
    update();

    return () => {
      observer.disconnect();
      host.style.removeProperty('--terminal-capsule-occlusion');
    };
  }, [shellRef]);
}
