import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorkspaceCapsuleClearance } from '@/app/workspace/hooks/useWorkspaceCapsuleClearance';
import {
  WORKSPACE_ACTIONS_BOTTOM_INSET,
  WORKSPACE_BOUNDED_SCROLL_MARKER,
  WORKSPACE_CONTENT_BOTTOM_INSET,
  WORKSPACE_SCROLL_BOTTOM_INSET,
  workspaceBoundedScrollClearanceClass,
} from '@/shared/lib/workspaceScrollClearance';

function rect(top: number, height: number) {
  return {
    bottom: top + height,
    top,
    left: 0,
    right: 300,
    width: 300,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * The Workspace shell's real DOM shape: the shell is the positioned root, the
 * view fills it, and the tool bar — when the capsule draws one — floats at the
 * bottom as the last child (SC-11: an overlay, not a sibling row).
 */
function workspaceDom({ withBar }: { withBar: boolean }) {
  const shell = document.createElement('div');
  shell.dataset.testid = 'workspace-shell';
  document.body.appendChild(shell);

  vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(rect(0, 400));

  let bar: HTMLElement | null = null;
  if (withBar) {
    bar = document.createElement('div');
    bar.dataset.testid = 'workspace-tool-bar';
    shell.appendChild(bar);
    // The floating band the bar occupies: its top (340) to the shell's bottom
    // (400) — bar height plus the zone's own bottom offset.
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(340, 48));
  }

  return { shell, bar };
}

describe('useWorkspaceCapsuleClearance', () => {
  let observe: ReturnType<typeof vi.fn>;
  let unobserve: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
        constructor(callback: ResizeObserverCallback) {
          observe.mockImplementation(() => {
            callback([], this as unknown as ResizeObserver);
          });
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the floating band on the shell from the tool bar geometry', () => {
    const { shell } = workspaceDom({ withBar: true });

    renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));

    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('60px');
    expect(shell.style.getPropertyValue(WORKSPACE_ACTIONS_BOTTOM_INSET)).toBe('60px');
    // No App surface marker (Web shape): the shell itself is the scroller.
    expect(shell.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('60px');
    expect(observe).toHaveBeenCalledWith(shell);
  });

  it('measures the scroll inset from the element that actually scrolls (#4115)', () => {
    const { shell } = workspaceDom({ withBar: true });
    const surface = document.createElement('div');
    surface.setAttribute('data-workspace-app-surface', 'document');
    shell.appendChild(surface);
    // A Host-owned actions row sits below the scrollport: the scrollport's
    // bottom (310) is already 30px above the bar's top (340), so the honest
    // trailing extent is zero rather than a reserved blank tail.
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(100, 210));

    renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));

    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('60px');
    expect(shell.style.getPropertyValue(WORKSPACE_ACTIONS_BOTTOM_INSET)).toBe('60px');
    expect(shell.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('0px');
  });

  it('measures every declared bounded scrollport at its own bottom (#4222 SC-02)', () => {
    const { shell } = workspaceDom({ withBar: true }); // floating top = 340
    const scrollport = (bottom: number, scrolls: boolean, label: string) => {
      const element = document.createElement('div');
      element.className = WORKSPACE_BOUNDED_SCROLL_MARKER;
      element.setAttribute('data-testid', label);
      Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        value: scrolls ? 600 : 100,
      });
      Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        value: 200,
      });
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(bottom - 200, 200));
      shell.appendChild(element);
      return element;
    };
    // Two scrollers ending at different coordinates, plus a declared marker
    // that is not itself overflowed. A single inherited shell number would be
    // wrong for both split readers; an auto-height marker must not add a tail.
    const upper = scrollport(300, true, 'upper');
    const lower = scrollport(380, true, 'lower');
    const staticMarker = scrollport(395, false, 'static');

    renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));

    expect(upper.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('0px');
    expect(lower.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('40px');
    expect(staticMarker.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('0px');
    // The document surface's shell-wide value is unchanged.
    expect(shell.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('60px');
  });

  it('removes per-scrollport measurements on unmount (#4222 SC-02)', () => {
    const { shell } = workspaceDom({ withBar: true });
    const element = document.createElement('div');
    element.className = WORKSPACE_BOUNDED_SCROLL_MARKER;
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 200 });
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(180, 200));
    shell.appendChild(element);

    const { unmount } = renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));
    expect(element.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('40px');

    unmount();
    expect(element.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('');
  });

  it('counts the App safe area once when no bar is drawn', () => {
    const { shell } = workspaceDom({ withBar: false });
    // The App viewport environment publishes the safe-area bottom as a
    // shell-local snapshot; the fallback anchor is shell.bottom minus it.
    shell.setAttribute('data-app-viewport-environment', '');
    const surface = document.createElement('div');
    surface.setAttribute('data-workspace-app-surface', 'document');
    shell.appendChild(surface);
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect(100, 300));

    renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));
    shell.dispatchEvent(
      new CustomEvent('nession:app-viewport-snapshot', {
        detail: { safeArea: { top: 0, right: 0, bottom: 34, left: 0 } },
      }),
    );

    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('34px');
    expect(shell.style.getPropertyValue(WORKSPACE_SCROLL_BOTTOM_INSET)).toBe('34px');
  });

  it('publishes zero rather than a stale measurement when no bar is drawn', () => {
    // The bar is conditional (`showDock || showSurfaceAction`): no capabilities
    // means nothing floats, and the content region must go back to full height
    // without reserving anything permanently (SC-12's trailing-clearance rule).
    const { shell } = workspaceDom({ withBar: false });

    renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));

    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('0px');
  });

  it('picks the bar up when it mounts after the shell', async () => {
    const { shell } = workspaceDom({ withBar: false });
    renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));
    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('0px');

    const bar = document.createElement('div');
    bar.dataset.testid = 'workspace-tool-bar';
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(rect(340, 48));
    shell.appendChild(bar);

    await waitFor(() =>
      expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('60px'),
    );
  });

  it('removes the property on unmount instead of leaving a number behind', () => {
    const { shell } = workspaceDom({ withBar: true });
    const { unmount } = renderHook(() => useWorkspaceCapsuleClearance({ current: shell }));
    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('60px');

    unmount();

    expect(shell.style.getPropertyValue(WORKSPACE_CONTENT_BOTTOM_INSET)).toBe('');
  });

  it('pins the variable name both halves of SC-12 agree on', () => {
    // The hook publishes it and every capability scroller's class consumes it;
    // these are two files apart, and a rename on one side would silently zero
    // the clearance on the other. The literal is the contract.
    expect(WORKSPACE_CONTENT_BOTTOM_INSET).toBe(
      '--nession-local-workspace-content-bottom-inset',
    );
    expect(WORKSPACE_SCROLL_BOTTOM_INSET).toBe(
      '--nession-local-workspace-scroll-bottom-inset',
    );
    expect(WORKSPACE_ACTIONS_BOTTOM_INSET).toBe(
      '--nession-local-workspace-actions-bottom-inset',
    );
    expect(workspaceBoundedScrollClearanceClass).toBe(
      `${WORKSPACE_BOUNDED_SCROLL_MARKER} pb-[var(--nession-local-workspace-scroll-bottom-inset,0px)]`,
    );
  });
});
