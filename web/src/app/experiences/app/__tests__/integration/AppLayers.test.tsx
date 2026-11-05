import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayers } from '../../AppLayers';
import { EDGE_PLATFORM_GUARD_PX } from '../../gesture';

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

/** Pin the App root's rect: jsdom reports zeros, which every x is inside. */
function pinShell(right: number) {
  const root = screen.getByTestId('app-layer-root');
  root.getBoundingClientRect = () =>
    ({ left: 0, right, top: 0, bottom: 600, width: right, height: 600, x: 0, y: 0 }) as DOMRect;
  return root;
}

function touchAt(clientX: number, clientY = 300, identifier = 1) {
  return { identifier, clientX, clientY };
}

/**
 * Dispatch a native touch sequence on `target`. The pager listens on the App
 * root in the capture phase, so a target inside a layer is what a real finger
 * would hit.
 */
function drag(
  target: HTMLElement,
  points: Array<[number, number]>,
) {
  const [start, ...rest] = points;
  if (!start) {
    throw new Error('a drag needs a start point');
  }
  fireEvent.touchStart(target, {
    touches: [touchAt(start[0], start[1])],
    changedTouches: [touchAt(start[0], start[1])],
  });
  for (const [x, y] of rest) {
    fireEvent.touchMove(target, {
      touches: [touchAt(x, y)],
      changedTouches: [touchAt(x, y)],
    });
  }
  const last = points[points.length - 1];
  fireEvent.touchEnd(target, {
    touches: [],
    changedTouches: [touchAt(last[0], last[1])],
  });
}

describe('AppLayers — Terminal is the root', () => {
  it('mounts the Terminal layer for every active layer', () => {
    // The whole point of the composition: navigating must not unmount the
    // root, because that is what would rebuild xterm, the attach state and
    // the scrollback. Asserted across all three states rather than only at
    // rest, since the failure mode is specifically "it disappeared when we
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
  function swipeRight(fromX: number, toX: number) {
    // The touch lands on the work surface, not on the root: the gate walks up
    // from the target, so a test that dispatched on the root itself would not
    // exercise the branch the band exists for.
    const surface = screen.getByTestId('stub-work-surface');
    drag(surface, [
      [fromX, 300],
      [fromX + (toX - fromX) / 2, 300],
      [toX, 300],
    ]);
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

  it('pages Sessions from a left-edge drag that starts on the work surface', async () => {
    // The end-to-end wiring #1081 is: the band is only reachable if AppLayers
    // hands the hook *this element's* rect. A `() => null` here, or a band
    // measured from the window, compiles and leaves every unit test above
    // green while the gesture stays dead in the App.
    const onLayerChange = renderWithWorkSurface();
    pinShell(390);

    swipeRight(EDGE_PLATFORM_GUARD_PX + 2, 120);

    await waitFor(() => expect(onLayerChange).toHaveBeenCalledWith('sessions'));
  });

  it('leaves a drag that starts on the work surface interior alone', async () => {
    const onLayerChange = renderWithWorkSurface();
    pinShell(390);

    swipeRight(200, 320);

    // Release begins a snapback; give it its window, then prove silence.
    await new Promise((resolve) => setTimeout(resolve, 260));
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
    drag(target, [
      [fromX, 300],
      [fromX + (toX - fromX) / 2, 300],
      [toX, 300],
    ]);
  }

  it('does not page from the page header while a detail is pushed', async () => {
    // The header is chrome, so the work-surface gate never applied to it — this
    // route to the shell's leave is older than #1081 and is what silently
    // discarded an unsaved editor: Files' Back refuses, the shell's leave does
    // not. The header drag is the one that reaches it without the band.
    const onLayerChange = renderWorkspaceLayer(true);
    pinShell(390);

    dragOn(screen.getByTestId('stub-page-header'), EDGE_PLATFORM_GUARD_PX + 20, EDGE_PLATFORM_GUARD_PX + 190);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(onLayerChange).not.toHaveBeenCalled();
  });

  it('does not page from the editor itself while a detail is pushed', async () => {
    // The route #1081 introduced: the band re-admitted the work surface, and
    // CodeMirror's line-number gutter sits at x = 0, inside the band.
    const onLayerChange = renderWorkspaceLayer(true);
    pinShell(390);

    dragOn(screen.getByTestId('stub-editor'), EDGE_PLATFORM_GUARD_PX + 20, EDGE_PLATFORM_GUARD_PX + 190);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(onLayerChange).not.toHaveBeenCalled();
  });

  it('still pages the Workspace layer from its root', async () => {
    // The pair: standing down is scoped to a pushed detail. At the root the
    // shell's leave and Back are the same destination, so the gesture stays.
    const onLayerChange = renderWorkspaceLayer(false);
    pinShell(390);

    dragOn(screen.getByTestId('stub-page-header'), EDGE_PLATFORM_GUARD_PX + 20, EDGE_PLATFORM_GUARD_PX + 190);

    await waitFor(() => expect(onLayerChange).toHaveBeenCalledWith('terminal'));
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

  it('removes the leftward page rather than sliding onto nothing', async () => {
    // Null is "this layer does not exist", not "render an empty one": the pager
    // counts two positions, so the gesture that would open Workspace resists
    // and snaps back instead of sliding onto a blank depth.
    const onLayerChange = renderWithoutWorkspace();
    const surface = screen.getByTestId('stub-terminal');

    drag(surface, [
      [300, 300],
      [180, 300],
      [40, 300],
    ]);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(onLayerChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
    expect(screen.queryByTestId('app-layer-workspace')).toBeNull();
  });

  it('still pages Sessions, because that layer does exist', async () => {
    // The pair matters: the assertion above would also pass if the pager were
    // broken outright.
    const onLayerChange = renderWithoutWorkspace();
    pinShell(390);
    const surface = screen.getByTestId('stub-terminal');

    drag(surface, [
      [40, 300],
      [160, 300],
      [300, 300],
    ]);

    await waitFor(() => expect(onLayerChange).toHaveBeenCalledWith('sessions'));
  });
});

describe('AppLayers — in-flight feedback exists only during a drag (#2724)', () => {
  function renderTerminal(onLayerChange = vi.fn()) {
    render(
      <AppLayers
        layer="terminal"
        onLayerChange={onLayerChange}
        sessions={<div data-testid="stub-sessions" />}
        terminal={<div data-testid="stub-terminal" />}
        workspace={<div data-testid="stub-workspace" />}
        workspaceDetailPushed={false}
      />,
    );
  }

  it('has no destination affordance at rest', () => {
    renderTerminal();
    pinShell(390);

    expect(screen.queryByTestId('app-swipe-preview')).toBeNull();
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute('data-swipe-phase', 'idle');
  });

  it('names the frozen destination during the drag and removes it on release', async () => {
    renderTerminal();
    pinShell(390);
    const chrome = screen.getByTestId('stub-terminal');

    fireEvent.touchStart(chrome, {
      touches: [touchAt(200)],
      changedTouches: [touchAt(200)],
    });
    fireEvent.touchMove(chrome, {
      touches: [touchAt(340)],
      changedTouches: [touchAt(340)],
    });

    const preview = screen.getByTestId('app-swipe-preview');
    expect(preview).toHaveTextContent('Sessions');
    expect(preview).toHaveAttribute('data-direction', 'right');
    expect(preview).toHaveAttribute('data-destination', 'sessions');

    // Reverse: the destination is frozen and still named, but travel clamps.
    fireEvent.touchMove(chrome, {
      touches: [touchAt(120)],
      changedTouches: [touchAt(120)],
    });
    expect(screen.getByTestId('app-swipe-preview')).toHaveTextContent('Sessions');

    fireEvent.touchEnd(chrome, {
      touches: [],
      changedTouches: [touchAt(120)],
    });
    expect(screen.queryByTestId('app-swipe-preview')).toBeNull();
  });

  it('labels index 1 as Home when there is no Session', () => {
    render(
      <AppLayers
        layer="sessions"
        onLayerChange={vi.fn()}
        sessions={<div data-testid="stub-sessions" />}
        terminal={<div data-testid="stub-terminal" />}
        workspace={null}
        workspaceDetailPushed={false}
      />,
    );
    pinShell(390);
    const surface = screen.getByTestId('stub-sessions');

    fireEvent.touchStart(surface, {
      touches: [touchAt(390 - EDGE_PLATFORM_GUARD_PX - 2)],
      changedTouches: [touchAt(390 - EDGE_PLATFORM_GUARD_PX - 2)],
    });
    fireEvent.touchMove(surface, {
      touches: [touchAt(390 - EDGE_PLATFORM_GUARD_PX - 122)],
      changedTouches: [touchAt(390 - EDGE_PLATFORM_GUARD_PX - 122)],
    });

    expect(screen.getByTestId('app-swipe-preview')).toHaveTextContent('Home');
  });

  it('does not flash the far-side layer when Workspace settles to Terminal', () => {
    // Moving Workspace right reaches the Sessions position at exactly one
    // shell width. The visible outcome must be Workspace leaving, not Sessions
    // arriving before Terminal.
    render(
      <AppLayers
        layer="workspace"
        onLayerChange={vi.fn()}
        sessions={<div data-testid="stub-sessions" />}
        terminal={<div data-testid="stub-terminal" />}
        workspace={<div data-testid="stub-workspace" />}
        workspaceDetailPushed={false}
      />,
    );
    pinShell(390);

    const header = screen.getByTestId('stub-workspace');
    const from = EDGE_PLATFORM_GUARD_PX + 20;
    fireEvent.touchStart(header, {
      touches: [touchAt(from)],
      changedTouches: [touchAt(from)],
    });
    fireEvent.touchMove(header, {
      touches: [touchAt(from + 200)],
      changedTouches: [touchAt(from + 200)],
    });

    // The live drag is already the failure window: the three-slot geometry
    // would slide Sessions in from the left once the rightward travel reaches
    // a shell width.
    expect(screen.getByTestId('app-layer-root')).toHaveAttribute('data-swipe-phase', 'navigation');
    expect(screen.queryByTestId('app-layer-sessions')).toBeNull();
    expect(screen.getByTestId('app-layer-workspace')).toBeInTheDocument();

    fireEvent.touchEnd(header, {
      touches: [],
      changedTouches: [touchAt(from + 200)],
    });

    expect(screen.getByTestId('app-layer-root')).toHaveAttribute('data-swipe-phase', 'settling');
    expect(screen.queryByTestId('app-layer-sessions')).toBeNull();
    expect(screen.getByTestId('app-layer-workspace')).toBeInTheDocument();
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
