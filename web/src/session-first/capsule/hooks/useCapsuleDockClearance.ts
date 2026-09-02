import { useLayoutEffect, type RefObject } from 'react';

/**
 * Publishes --terminal-capsule-clearance on the nearest [data-terminal-capsule-host]
 * so xterm viewport padding keeps the cursor row above the floating dock.
 */
export function useCapsuleDockClearance(dockRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      return;
    }

    const host = dock.closest('[data-terminal-capsule-host]');
    if (!(host instanceof HTMLElement)) {
      return;
    }

    const update = () => {
      const hostRect = host.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const gapRaw = getComputedStyle(host).getPropertyValue('--composer-terminal-clearance-gap');
      const gap = Number.parseFloat(gapRaw) || 0;
      const clearance = Math.max(0, hostRect.bottom - dockRect.top + gap);
      host.style.setProperty('--terminal-capsule-clearance', `${clearance}px`);
    };

    const observer = new ResizeObserver(update);
    observer.observe(dock);
    observer.observe(host);
    update();

    return () => {
      observer.disconnect();
      host.style.removeProperty('--terminal-capsule-clearance');
    };
  }, [dockRef]);
}
