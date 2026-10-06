import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorkspaceCapsuleClearance } from '@/app/workspace/hooks/useWorkspaceCapsuleClearance';
import {
  WORKSPACE_CONTENT_BOTTOM_INSET,
  workspaceScrollClearanceClass,
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
    expect(observe).toHaveBeenCalledWith(shell);
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
    expect(workspaceScrollClearanceClass).toBe(
      'pb-[var(--nession-local-workspace-content-bottom-inset,0px)]',
    );
  });
});
