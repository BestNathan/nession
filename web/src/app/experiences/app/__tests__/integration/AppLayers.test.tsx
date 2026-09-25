import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayers } from '../../AppLayers';

function renderLayers(layer: 'sessions' | 'terminal' | 'workspace') {
  return render(
    <AppLayers
      layer={layer}
      onLayerChange={vi.fn()}
      sessions={<div data-testid="stub-sessions" />}
      terminal={<div data-testid="stub-terminal" />}
      workspace={<div data-testid="stub-workspace" />}
    />,
  );
}

describe('AppLayers — Terminal is the root', () => {
  it('mounts the Terminal layer for every active layer', () => {
    // The whole point of the composition: navigating must not unmount the
    // root, because that is what would rebuild xterm, the attach state and
    // the scrollback. Asserted across all three states rather than only at
    // rest, since the failure mode is specifically "it disappeared when I
    // opened something".
    for (const layer of ['terminal', 'sessions', 'workspace'] as const) {
      const { unmount } = renderLayers(layer);
      expect(screen.getByTestId('app-layer-terminal')).toBeInTheDocument();
      expect(screen.getByTestId('stub-terminal')).toBeInTheDocument();
      unmount();
    }
  });

  it('reports which layer is active', () => {
    renderLayers('workspace');
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute(
      'data-layer',
      'workspace',
    );
  });
});

describe('AppLayers — layers are not permanently mounted', () => {
  it('mounts neither layer while Terminal is at rest', () => {
    renderLayers('terminal');
    expect(screen.queryByTestId('app-layer-sessions')).toBeNull();
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
    expect(screen.queryByTestId('stub-sessions')).toBeNull();
    expect(screen.queryByTestId('stub-workspace')).toBeNull();
  });

  it('mounts only the layer that is open', () => {
    const { unmount } = renderLayers('sessions');
    expect(screen.getByTestId('app-layer-sessions')).toBeInTheDocument();
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
    unmount();
  });
});

describe('AppLayers — the shell does not put navigation chrome on the work surface', () => {
  it('renders no navigation affordance of its own over the Terminal', () => {
    // Carried over from `AppSpatialShell.test.tsx`, whose file was deleted with
    // the pager. The invariant outlives the component it was written against:
    // the shell owns gesture and layer plumbing, and must not grow its own
    // Sessions/Workspace buttons overlaying the work surface. Visible
    // non-gesture navigation belongs to the header (`app-header-sessions`,
    // `app-header-workspace`), which the Terminal's ShellMain renders.
    renderLayers('terminal');
    const root = screen.getByTestId('app-layer-root');
    expect(root.querySelector('[data-testid^="app-spatial-open-"]')).toBeNull();
    expect(root.querySelector('[data-testid^="app-layer-open-"]')).toBeNull();
  });
});
