import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorkspaceClearancePx } from '@/platform/explorer/hooks/useWorkspaceClearancePx';
import { WORKSPACE_CONTENT_BOTTOM_INSET } from '@/shared/lib/workspaceScrollClearance';

/**
 * The Workspace shell's real shape for this hook: the published inset is an
 * inline style on the shell (what `useWorkspaceCapsuleClearance` writes) and
 * the measured container is inside it.
 */
function workspaceDom() {
  const shell = document.createElement('div');
  shell.dataset.testid = 'workspace-shell';
  document.body.appendChild(shell);

  const container = document.createElement('div');
  shell.appendChild(container);

  return { shell, container };
}

describe('useWorkspaceClearancePx', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the published inset the Workspace shell carries', () => {
    const { shell, container } = workspaceDom();
    shell.style.setProperty(WORKSPACE_CONTENT_BOTTOM_INSET, '68px');

    const { result } = renderHook(() => useWorkspaceClearancePx({ current: container }));

    expect(result.current).toBe(68);
  });

  it('is zero when the Workspace has published nothing', () => {
    const { container } = workspaceDom();

    const { result } = renderHook(() => useWorkspaceClearancePx({ current: container }));

    expect(result.current).toBe(0);
  });

  it('follows the shell when the measurement moves', async () => {
    // The bar appearing moves the number without resizing this container —
    // the bar floats over it — so the hook listens to the shell's style
    // rather than to a ResizeObserver of its own box.
    const { shell, container } = workspaceDom();
    const { result } = renderHook(() => useWorkspaceClearancePx({ current: container }));
    expect(result.current).toBe(0);

    shell.style.setProperty(WORKSPACE_CONTENT_BOTTOM_INSET, '64px');

    await waitFor(() => expect(result.current).toBe(64));
  });

  it('returns to zero when the bar leaves and the inset collapses', async () => {
    const { shell, container } = workspaceDom();
    shell.style.setProperty(WORKSPACE_CONTENT_BOTTOM_INSET, '64px');
    const { result } = renderHook(() => useWorkspaceClearancePx({ current: container }));
    expect(result.current).toBe(64);

    shell.style.setProperty(WORKSPACE_CONTENT_BOTTOM_INSET, '0px');

    await waitFor(() => expect(result.current).toBe(0));
  });
});
