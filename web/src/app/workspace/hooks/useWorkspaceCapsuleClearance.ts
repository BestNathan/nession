import { useLayoutEffect, type RefObject } from 'react';
import {
  WORKSPACE_ACTIONS_BOTTOM_INSET,
  WORKSPACE_BOUNDED_SCROLL_MARKER,
  WORKSPACE_CONTENT_BOTTOM_INSET,
  WORKSPACE_SCROLL_BOTTOM_INSET,
} from '@/shared/lib/workspaceScrollClearance';
import {
  APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE,
  APP_VIEWPORT_SNAPSHOT_EVENT,
  type AppViewportSnapshot,
} from '@/platform/viewport/appViewport';

/** The tool bar's contract with this hook — the element the zone draws itself into. */
const TOOL_BAR_SELECTOR = '[data-testid="workspace-tool-bar"]';

/**
 * The element that actually scrolls, published by the App host contract
 * (#4115): either the Host-owned page scrollport or a declared bounded region.
 * Web has no such marker; its band is measured against the shell itself.
 */
const APP_WORKSPACE_SURFACE_SELECTOR = '[data-workspace-app-surface]';

/**
 * Publishes the Workspace's Capsule clearances on the shell from the actual
 * Zone geometry (#1347 SC-12, #4115).
 *
 * Three numbers, one measurement:
 *
 * - **content band** — the shell's bottom to the floating bar's top. Safe area
 *   is already inside it: the bar is positioned with
 *   `max(shell-inset, safe-area)`, so its top cannot sit below that offset.
 * - **scroll inset** — the *scrolling viewport's* bottom to the same bar top.
 *   On App that viewport may be a Host scrollport or a declared bounded
 *   region; a Host-owned Bottom Actions row below the scrollport makes this
 *   zero, which is exactly the point: the scroll end must not reserve a blank
 *   tail for space that is already outside it.
 * - **per-scrollport inset** — the same value is written on every element
 *   carrying the bounded marker, measured from *that* element's own visible
 *   bottom. Split surfaces (a list above a warnings footer, an editor above a
 *   feedback pane) therefore do not share one number, and a marker that is not
 *   itself overflowing gets zero instead of a phantom tail (#4222 SC-02).
 * - **actions inset** — the full band, spent by the Host-owned actions slot so
 *   its controls sit above the Capsule at every overlay height.
 *
 * When no bar is drawn the anchor is the shell's bottom minus the App viewport
 * snapshot's safe-area bottom: the clear end of the surface is still the safe
 * area, and it is counted once rather than added to a measured band.
 *
 * The observers cover every input that moves a number: the shell resizes, the
 * bar resizes or mounts/unmounts, the scrolling surface resizes or is replaced,
 * and the App viewport publishes a new safe area (orientation, fixture input).
 * The event is the App environment's; Web has no environment and falls back to
 * the window resize it always had.
 */
export function useWorkspaceCapsuleClearance(shellRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const observed = new Set<HTMLElement>();
    // The last value written to each individually measured scrollport, so a
    // steady layout does not thrash inline styles on every observer tick.
    const measuredInsets = new Map<HTMLElement, number>();
    let safeAreaBottom = 0;

    const observe = (element: HTMLElement | null) => {
      if (!element || observed.has(element)) {
        return;
      }
      observed.add(element);
      resizeObserver.observe(element);
    };

    const forget = (element: HTMLElement) => {
      if (!observed.delete(element)) {
        return;
      }
      resizeObserver.unobserve(element);
      if (measuredInsets.delete(element)) {
        element.style.removeProperty(WORKSPACE_SCROLL_BOTTOM_INSET);
      }
    };

    const update = () => {
      const bar = shell.querySelector(TOOL_BAR_SELECTOR);
      const barElement = bar instanceof HTMLElement ? bar : null;
      const surface = shell.querySelector(APP_WORKSPACE_SURFACE_SELECTOR);
      const surfaceElement = surface instanceof HTMLElement ? surface : null;

      // Every declared bounded scrollport in this Workspace (#4222 SC-02).
      // Each one is measured against the same live Capsule top, but from its
      // own visible bottom: sibling scrollers that end at different
      // coordinates (a split reader, a list beside a detail pane) each get the
      // clearance that belongs to them instead of inheriting one number
      // derived from the outer surface.
      const scrollports = new Set<HTMLElement>(
        Array.from(
          shell.querySelectorAll<HTMLElement>(
            `[class~="${WORKSPACE_BOUNDED_SCROLL_MARKER}"]`,
          ),
        ),
      );

      // Drop observations for elements whose marker/lifecycle left the shell.
      for (const element of Array.from(observed)) {
        const stillNeeded =
          element === barElement || element === surfaceElement || scrollports.has(element);
        if (!stillNeeded || !element.isConnected) {
          forget(element);
        }
      }

      observe(barElement);
      observe(surfaceElement);

      const shellRect = shell.getBoundingClientRect();
      // The clear end of the surface: the floating bar's top, or the safe area
      // when nothing floats. Safe area never moves into the band twice.
      const floatingTop = barElement
        ? barElement.getBoundingClientRect().top
        : shellRect.bottom - safeAreaBottom;
      const contentBand = Math.max(0, shellRect.bottom - floatingTop);
      // The scroll extent belongs to the element that really scrolls. Without
      // an App surface marker (Web) the shell is that element.
      const scrollingBottom = surfaceElement
        ? surfaceElement.getBoundingClientRect().bottom
        : shellRect.bottom;
      const scrollInset = Math.max(0, scrollingBottom - floatingTop);

      shell.style.setProperty(WORKSPACE_CONTENT_BOTTOM_INSET, `${contentBand}px`);
      shell.style.setProperty(WORKSPACE_SCROLL_BOTTOM_INSET, `${scrollInset}px`);
      shell.style.setProperty(WORKSPACE_ACTIONS_BOTTOM_INSET, `${contentBand}px`);

      // Measured per element, not inherited from the shell: an auto-height
      // marker that is not itself a scroll owner gets zero, so it cannot add a
      // blank tail that nobody scrolls past.
      for (const element of scrollports) {
        observe(element);
        const scrollable = element.scrollHeight > element.clientHeight + 1;
        const inset = scrollable
          ? Math.max(0, element.getBoundingClientRect().bottom - floatingTop)
          : 0;
        if (measuredInsets.get(element) === inset) {
          continue;
        }
        element.style.setProperty(WORKSPACE_SCROLL_BOTTOM_INSET, `${inset}px`);
        measuredInsets.set(element, inset);
      }
    };

    const resizeObserver = new ResizeObserver(update);
    const mutationObserver = new MutationObserver(update);

    resizeObserver.observe(shell);
    mutationObserver.observe(shell, { childList: true, subtree: true });

    // The App's single viewport reader publishes safe-area changes as one
    // shell-local snapshot (#3523); consuming it keeps this hook from opening a
    // second `visualViewport` interpretation.
    const environment = shell.closest(`[${APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE}]`);
    const onSnapshot = (event: Event) => {
      const snapshot = (event as CustomEvent<AppViewportSnapshot>).detail;
      const next = snapshot?.safeArea?.bottom ?? 0;
      if (next !== safeAreaBottom) {
        safeAreaBottom = next;
        update();
      }
    };
    environment?.addEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, onSnapshot);
    window.addEventListener('resize', update);

    update();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      for (const element of measuredInsets.keys()) {
        element.style.removeProperty(WORKSPACE_SCROLL_BOTTOM_INSET);
      }
      measuredInsets.clear();
      environment?.removeEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, onSnapshot);
      window.removeEventListener('resize', update);
      shell.style.removeProperty(WORKSPACE_CONTENT_BOTTOM_INSET);
      shell.style.removeProperty(WORKSPACE_SCROLL_BOTTOM_INSET);
      shell.style.removeProperty(WORKSPACE_ACTIONS_BOTTOM_INSET);
    };
  }, [shellRef]);
}
