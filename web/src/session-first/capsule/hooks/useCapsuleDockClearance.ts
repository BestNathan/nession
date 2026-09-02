import { useLayoutEffect, type RefObject } from 'react';
import { TERMINAL_CAPSULE_OCCLUSION_EVENT } from '@/terminal/capsule/occlusionScroll';

/**
 * Publishes --terminal-capsule-occlusion on the nearest [data-terminal-capsule-host].
 * Occlusion height positions floating chrome (scroll controls) above the dock.
 * xterm uses the full well height; scrollback may pass under the capsule overlay
 * (ChatGPT-style — viewport is not inset with padding-bottom).
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
      host.style.setProperty('--terminal-capsule-occlusion', `${clearance}px`);
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_OCCLUSION_EVENT));
    };

    const observer = new ResizeObserver(update);
    observer.observe(dock);
    observer.observe(host);
    update();

    return () => {
      observer.disconnect();
      host.style.removeProperty('--terminal-capsule-occlusion');
    };
  }, [dockRef]);
}
