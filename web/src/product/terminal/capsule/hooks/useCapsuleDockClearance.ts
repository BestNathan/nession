import { useLayoutEffect, type RefObject } from 'react';
import {
  TERMINAL_CAPSULE_OCCLUSION_EVENT,
  TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT,
} from '@/platform/terminal-runtime/capsule/occlusionScroll';
import {
  APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE,
  APP_VIEWPORT_SNAPSHOT_EVENT,
} from '@/platform/viewport/appViewport';

/**
 * Publishes the dock's two different clearances on the nearest
 * `[data-terminal-capsule-host]`.
 *
 * ## 1. Composer occlusion — the terminal *fit* contract
 *
 * `--nession-local-terminal-capsule-occlusion` is not advisory:
 * `--nession-local-terminal-content-bottom-inset` derives from it and
 * `TerminalViewport` spends it as `padding-bottom` inside a `box-border`
 * element xterm is mounted in. Whatever this measures is height the terminal
 * genuinely loses, and it re-fits — rows change — every time the number moves.
 *
 * It therefore measures the **shell** (the composer), never the whole dock. The
 * dock also carries the upper slot; reserving terminal height for a temporary
 * surface reflows the work surface every time it appears and goes away, which
 * `capability-emergence.md` forbids. Measured at 390×844, `shell.top` was 368
 * both with and without a projection.
 *
 * ## 2. Upper-panel clearance — the terminal *scroll* contract (#2710 SC-08)
 *
 * `--nession-local-terminal-capsule-panel-clearance` is how far the highest
 * currently expanded floating surface rises above the composer. It is a
 * separate value precisely because it must never enter the fit path above:
 * `CapsuleOcclusionScroll` spends it as a visual scroll offset so the live
 * bottom can sit above the panel, while PTY/tmux/xterm rows stay exactly what
 * the composer-only occlusion decided. Collapsing the two would reflow the
 * terminal every time the user opened `+`.
 */
export function useCapsuleDockClearance(
  shellRef: RefObject<HTMLElement | null>,
  dockRef?: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const dock = dockRef?.current ?? null;
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
      const gapRaw = getComputedStyle(host).getPropertyValue('--nession-terminal-capsule-terminal-clearance-gap');
      const gap = Number.parseFloat(gapRaw) || 0;
      const clearance = Math.max(0, hostRect.bottom - shellRect.top + gap);
      host.style.setProperty('--nession-local-terminal-capsule-occlusion', `${clearance}px`);
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_OCCLUSION_EVENT));

      // The upper slot is a sibling above the shell in the same bottom-anchored
      // dock, so the dock's top is the top of whatever upper surface is open —
      // and exactly the shell's top when nothing is. No upper surface, no
      // clearance.
      const dockRect = dock ? dock.getBoundingClientRect() : shellRect;
      const panelClearance = Math.max(0, shellRect.top - dockRect.top);
      host.style.setProperty(
        '--nession-local-terminal-capsule-panel-clearance',
        `${panelClearance}px`,
      );
      host.dispatchEvent(new Event(TERMINAL_CAPSULE_PANEL_CLEARANCE_EVENT));
    };

    const observer = new ResizeObserver(update);
    observer.observe(shell);
    observer.observe(host);
    if (dock) {
      // The dock's height changes when a view switch changes panel content, and
      // it is bottom-anchored, so the same observation catches the new top.
      observer.observe(dock);
    }

    // Portrait/landscape, safe area and the soft keyboard are viewport events,
    // not dock resizes in every browser; the safe-area/edge case still has to
    // republish. The App's environment is the single viewport reader (#3523),
    // so this hook consumes its snapshot event rather than opening a second
    // `visualViewport` listener with its own interpretation of the geometry.
    // That event is absent on Web (which has no App environment), so the
    // window fallback stays.
    const environment = shell.closest(`[${APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE}]`);
    window.addEventListener('resize', update);
    environment?.addEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, update);
    update();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      environment?.removeEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, update);
      host.style.removeProperty('--nession-local-terminal-capsule-occlusion');
      host.style.removeProperty('--nession-local-terminal-capsule-panel-clearance');
    };
  }, [dockRef, shellRef]);
}
