import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayers } from '../../AppLayers';

function renderLayers(
  layer: 'sessions' | 'terminal' | 'workspace',
  workspaceDetailPushed = false,
) {
  return render(
    <AppLayers
      layer={layer}
      onLayerChange={vi.fn()}
      sessions={<div data-testid="stub-sessions" />}
      terminal={<div data-testid="stub-terminal" />}
      workspace={<div data-testid="stub-workspace" />}
      workspaceDetailPushed={workspaceDetailPushed}
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

  it('supplies the App popup container to every layer (#1066)', () => {
    // This element is the scope (`data-experience="app"`), so it is also the
    // one that has to give its popups a node carrying that scope — a menu
    // portalled to `<body>` is not a descendant of anything this root says.
    // Asserted from the composition, not from `AppPopupPortal` alone: removing
    // the wrapper from `AppLayers` is the way this regresses.
    for (const layer of ['terminal', 'sessions', 'workspace'] as const) {
      const { unmount } = renderLayers(layer);
      const host = screen.getByTestId('app-popup-portal');
      expect(host).toHaveAttribute('data-experience', 'app');
      expect(host.parentElement).toBe(document.body);
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

describe('AppLayers — the edge band is measured from this element (#1081)', () => {
  /** Pin the App root's rect: jsdom reports zeros, which every x is inside. */
  function pinShell(right: number) {
    const root = screen.getByTestId('app-layer-root');
    root.getBoundingClientRect = () =>
      ({ left: 0, right, top: 0, bottom: 600, width: right, height: 600, x: 0, y: 0 }) as DOMRect;
    return root;
  }

  function swipeRight(fromX: number, toX: number) {
    // The touch lands on the work surface, not on the root: the gate walks up
    // from the target, so a test that dispatched on the root itself would not
    // exercise the branch the band exists for.
    const surface = screen.getByTestId('stub-work-surface');
    fireEvent.touchStart(surface, { touches: [{ clientX: fromX, clientY: 300 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: toX, clientY: 300 }] });
    fireEvent.touchEnd(surface);
  }

  function renderWithWorkSurface(onLayerChange = vi.fn()) {
    render(
      <AppLayers
        layer="terminal"
        onLayerChange={onLayerChange}
        sessions={<div data-testid="stub-sessions" />}
        terminal={<div data-testid="stub-work-surface" data-terminal-viewport />}
        workspace={<div data-testid="stub-workspace" />}
        workspaceDetailPushed={false}
      />,
    );
    return onLayerChange;
  }

  it('pages Sessions from a left-edge drag that starts on the work surface', () => {
    // The end-to-end wiring #1081 is: the band is only reachable if AppLayers
    // hands the hook *this element's* rect. A `() => null` here, or a band
    // measured from the window, compiles and leaves every unit test above
    // green while the gesture stays dead in the App.
    const onLayerChange = renderWithWorkSurface();
    pinShell(390);

    swipeRight(2, 120);

    expect(onLayerChange).toHaveBeenCalledWith('sessions');
  });

  it('leaves a drag that starts on the work surface interior alone', () => {
    const onLayerChange = renderWithWorkSurface();
    pinShell(390);

    swipeRight(200, 320);

    expect(onLayerChange).not.toHaveBeenCalled();
  });
});

describe('AppLayers — a pushed Workspace detail owns its own leave (#1081)', () => {
  /** The Workspace layer with a work surface in it — an editor, in the product. */
  function renderWorkspaceLayer(
    workspaceDetailPushed: boolean,
    onLayerChange = vi.fn(),
  ) {
    render(
      <AppLayers
        layer="workspace"
        onLayerChange={onLayerChange}
        sessions={<div data-testid="stub-sessions" />}
        terminal={<div data-testid="stub-terminal" />}
        workspace={
          <div>
            <header data-testid="stub-page-header" />
            <div data-testid="stub-editor" data-terminal-viewport />
          </div>
        }
        workspaceDetailPushed={workspaceDetailPushed}
      />,
    );
    return onLayerChange;
  }

  function dragOn(target: HTMLElement, fromX: number, toX: number) {
    fireEvent.touchStart(target, { touches: [{ clientX: fromX, clientY: 300 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: fromX + (toX - fromX) / 2, clientY: 300 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: toX, clientY: 300 }] });
    fireEvent.touchEnd(target);
  }

  it('does not page from the page header while a detail is pushed', () => {
    // The header is chrome, so the work-surface gate never applied to it — this
    // route to the shell's leave is older than #1081 and is what silently
    // discarded an unsaved editor: Files' Back refuses, the shell's leave does
    // not. The header drag is the one that reaches it without the band.
    const onLayerChange = renderWorkspaceLayer(true);

    dragOn(screen.getByTestId('stub-page-header'), 20, 170);

    expect(onLayerChange).not.toHaveBeenCalled();
  });

  it('does not page from the editor itself while a detail is pushed', () => {
    // The route #1081 introduced: the band re-admitted the work surface, and
    // CodeMirror's line-number gutter sits at x = 0, inside the band.
    const onLayerChange = renderWorkspaceLayer(true);

    dragOn(screen.getByTestId('stub-editor'), 20, 170);

    expect(onLayerChange).not.toHaveBeenCalled();
  });

  it('still pages the Workspace layer from its root', () => {
    // The pair: standing down is scoped to a pushed detail. At the root the
    // shell's leave and Back are the same destination, so the gesture stays.
    const onLayerChange = renderWorkspaceLayer(false);

    dragOn(screen.getByTestId('stub-page-header'), 20, 170);

    expect(onLayerChange).toHaveBeenCalledWith('terminal');
  });
});

describe('AppLayers — a null Workspace layer does not exist (#1082)', () => {
  function renderWithoutWorkspace(onLayerChange = vi.fn()) {
    render(
      <AppLayers
        layer="terminal"
        onLayerChange={onLayerChange}
        sessions={<div data-testid="stub-sessions" />}
        terminal={<div data-testid="stub-terminal" />}
        workspace={null}
        workspaceDetailPushed={false}
      />,
    );
    return onLayerChange;
  }

  it('renders no Workspace layer', () => {
    renderWithoutWorkspace();
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
  });

  it('removes the leftward page rather than sliding onto nothing', () => {
    // Null is "this layer does not exist", not "render an empty one": the pager
    // counts two positions, so the gesture that would open Workspace is a no-op
    // instead of a slide onto a blank depth.
    const onLayerChange = renderWithoutWorkspace();
    const root = screen.getByTestId('app-layer-root');
    const surface = screen.getByTestId('stub-terminal');

    fireEvent.touchStart(surface, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 180, clientY: 300 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.touchEnd(surface);

    expect(onLayerChange).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="app-layer-workspace"]')).toBeNull();
  });

  it('still pages Sessions, because that layer does exist', () => {
    // The pair matters: the assertion above would also pass if the pager were
    // broken outright.
    const onLayerChange = renderWithoutWorkspace();
    const surface = screen.getByTestId('stub-terminal');

    fireEvent.touchStart(surface, { touches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 160, clientY: 300 }] });
    fireEvent.touchMove(surface, { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchEnd(surface);

    expect(onLayerChange).toHaveBeenCalledWith('sessions');
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
