import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TouchEvent } from 'react';
import type { ShellBounds } from '../../edgeBand';
import { EDGE_BAND_PX, SWIPE_COMMIT_PX } from '../../gesture';
import { useSwipePager } from '../../useSwipePager';

/**
 * The shell every test measures its edge bands against unless it says
 * otherwise. 400 rather than a real phone width so the band arithmetic below
 * reads as arithmetic; nothing in the hook depends on the number.
 */
const SHELL: ShellBounds = { left: 0, right: 400 };

/**
 * Build a detached element tree and return the node `selector` picks out of it.
 *
 * The leaf matters: the start gate walks *up* from the touch target, so a test
 * that handed `closest()` the work-surface root itself would pass even if the
 * walk-up were broken.
 */
function element(html: string, selector: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const found = host.querySelector(selector);
  if (!found) {
    throw new Error(`no element matched ${selector}`);
  }
  return found;
}

/** Ordinary shell chrome — what top-level navigation is allowed to start on. */
function chrome(): Element {
  return element(
    '<div data-testid="app-spatial-shell"><div class="shell-chrome"></div></div>',
    '.shell-chrome',
  );
}

function touchEvent(
  clientX: number,
  clientY = 0,
  target: EventTarget | null = null,
): TouchEvent {
  return {
    touches: [{ clientX, clientY } as Touch],
    target,
  } as unknown as TouchEvent;
}

describe('SWIPE_COMMIT_PX', () => {
  it('equals 80', () => {
    expect(SWIPE_COMMIT_PX).toBe(80);
  });
});

describe('useSwipePager', () => {
  const width = 400;

  function setup(
    index: number,
    pageCount = 3,
    bounds: ShellBounds | null = SHELL,
    shellMayPage = true,
  ) {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipePager({
        pageCount,
        index,
        onIndexChange,
        getShellBounds: () => bounds,
        shellMayPage,
      }),
    );
    return { onIndexChange, result };
  }

  function drag(
    result: { current: ReturnType<typeof useSwipePager> },
    from: [number, number],
    to: [number, number],
    target: EventTarget | null = chrome(),
  ) {
    act(() => {
      result.current.onTouchStart(touchEvent(from[0], from[1], target));
      result.current.onTouchMove(touchEvent(to[0], to[1]));
      result.current.onTouchEnd();
    });
  }

  it('turns the page from a drag that starts on shell chrome', () => {
    // Shell chrome is unconstrained: the edge band (#1081) is an exception
    // added over work surfaces, so it takes nothing away here. The gesture
    // keeps its whole width wherever the shell already owned the touch.
    const { onIndexChange, result } = setup(1);

    drag(result, [width / 2, 300], [width / 2 + SWIPE_COMMIT_PX + 10, 300]);

    expect(onIndexChange).toHaveBeenCalledWith(0);
    expect(result.current.dragOffset).toBe(0);
  });

  it('ignores a predominantly vertical drag, so scrolling is never hijacked', () => {
    const { onIndexChange, result } = setup(1);

    // 30px across, 120px down: a scroll that drifted sideways.
    drag(result, [width / 2, 100], [width / 2 + 30, 220]);

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  it('locks the axis on the first move and stays locked for the gesture', () => {
    const { onIndexChange, result } = setup(1);

    act(() => {
      result.current.onTouchStart(touchEvent(width / 2, 100, chrome()));
      // Vertical first — the gesture is surrendered to the scroll.
      result.current.onTouchMove(touchEvent(width / 2 + 5, 260));
      // A later horizontal move must not revive it.
      result.current.onTouchMove(touchEvent(width / 2 + 200, 260));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  it('does not commit below the threshold', () => {
    const { onIndexChange, result } = setup(1);

    drag(result, [width / 2, 300], [width / 2 + SWIPE_COMMIT_PX - 10, 300]);

    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('follows the finger while dragging', () => {
    const { result } = setup(1);

    act(() => {
      result.current.onTouchStart(touchEvent(width / 2, 300, chrome()));
      result.current.onTouchMove(touchEvent(width / 2 + 40, 300));
    });

    expect(result.current.dragOffset).toBe(40);
    expect(result.current.isDragging).toBe(true);

    act(() => {
      result.current.onTouchEnd();
    });
    expect(result.current.dragOffset).toBe(0);
  });

  it('commits index-1 when dragging right', () => {
    const { onIndexChange, result } = setup(1);

    drag(result, [200, 300], [200 + 90, 300]);

    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('commits index+1 when dragging left', () => {
    const { onIndexChange, result } = setup(1);

    drag(result, [200, 300], [200 - 90, 300]);

    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it('does not call onIndexChange when dragging right at index 0', () => {
    const { onIndexChange, result } = setup(0);

    drag(result, [200, 300], [200 + 90, 300]);

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });
});

describe('useSwipePager — a work surface owns the touches that begin in it', () => {
  const width = 400;

  function setup(index: number, pageCount = 3, shellMayPage = true) {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipePager({
        pageCount,
        index,
        onIndexChange,
        getShellBounds: () => SHELL,
        shellMayPage,
      }),
    );
    return { onIndexChange, result };
  }

  // Each case is a real nesting: the touch lands on the leaf, and the gate has
  // to walk up to find the surface it belongs to.
  const workSurfaces: Array<[string, string, string]> = [
    [
      'the terminal viewport',
      '<div data-terminal-viewport><div class="xterm"><div class="xterm-screen"></div></div></div>',
      '.xterm-screen',
    ],
    [
      'a CodeMirror editor',
      '<div class="cm-editor"><div class="cm-scroller"><div class="cm-content"></div></div></div>',
      '.cm-content',
    ],
    [
      'a text field',
      '<form><label><textarea name="q"></textarea></label></form>',
      'textarea',
    ],
    [
      'the capsule',
      '<div data-testid="terminal-capsule"><div data-testid="capsule-shell"><input /></div></div>',
      'input',
    ],
  ];

  it.each(workSurfaces)(
    'does not start a page from a drag beginning in %s',
    (_name, html, selector) => {
      const { onIndexChange, result } = setup(1);
      const target = element(html, selector);

      act(() => {
        result.current.onTouchStart(touchEvent(width / 2, 300, target));
        result.current.onTouchMove(
          touchEvent(width / 2 + SWIPE_COMMIT_PX + 10, 300),
        );
        result.current.onTouchEnd();
      });

      expect(onIndexChange).not.toHaveBeenCalled();
      // Not merely "did not commit": the gesture never began at all, so there
      // is nothing tracking the finger and nothing left for a later move to
      // revive.
      expect(result.current.isDragging).toBe(false);
      expect(result.current.dragOffset).toBe(0);
    },
  );

  it('leaves the work surface free to move afterwards', () => {
    const { onIndexChange, result } = setup(1);
    const target = element(
      '<div data-terminal-viewport><div class="xterm"></div></div>',
      '.xterm',
    );

    act(() => {
      result.current.onTouchStart(touchEvent(width / 2, 300, target));
      // The surface's own gesture: a long horizontal drag over the terminal.
      result.current.onTouchMove(touchEvent(width / 2 + 300, 300));
    });

    expect(result.current.dragOffset).toBe(0);
    expect(result.current.isDragging).toBe(false);

    act(() => {
      result.current.onTouchEnd();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('still pages from a drag that starts on non-work chrome', () => {
    const { onIndexChange, result } = setup(1);
    // Sibling of the work surface, not inside it — the gate walks up, and the
    // walk must stop at the shell.
    const target = element(
      '<div data-testid="app-spatial-page-terminal"><header class="chrome"></header><div data-terminal-viewport></div></div>',
      'header.chrome',
    );

    act(() => {
      result.current.onTouchStart(touchEvent(width / 2, 300, target));
      result.current.onTouchMove(touchEvent(width / 2 - SWIPE_COMMIT_PX - 10, 300));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it('allows a start it cannot classify', () => {
    // The rule names what is excluded; it is not a whitelist. A caller that
    // hands over a bare event object must not silently lose the gesture.
    const { onIndexChange, result } = setup(1);

    act(() => {
      result.current.onTouchStart(touchEvent(width / 2, 300, null));
      result.current.onTouchMove(
        touchEvent(width / 2 + SWIPE_COMMIT_PX + 10, 300),
      );
      result.current.onTouchEnd();
    });

    expect(onIndexChange).toHaveBeenCalledWith(0);
  });
});

describe('useSwipePager — the shell edges re-admit the work surface (#1081)', () => {
  const width = 400;

  function setup(
    index: number,
    pageCount = 3,
    bounds: ShellBounds | null = SHELL,
    shellMayPage = true,
  ) {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipePager({
        pageCount,
        index,
        onIndexChange,
        getShellBounds: () => bounds,
        shellMayPage,
      }),
    );
    return { onIndexChange, result };
  }

  /** The terminal viewport, entered at a deep leaf so the walk-up is exercised. */
  function xterm(): Element {
    return element(
      '<div data-terminal-viewport><div class="xterm"><div class="xterm-screen"></div></div></div>',
      '.xterm-screen',
    );
  }

  function drag(
    result: { current: ReturnType<typeof useSwipePager> },
    from: [number, number],
    to: [number, number],
    target: EventTarget | null = xterm(),
  ) {
    act(() => {
      result.current.onTouchStart(touchEvent(from[0], from[1], target));
      result.current.onTouchMove(touchEvent(to[0], to[1]));
      result.current.onTouchEnd();
    });
  }

  it('pulls Sessions in from the left band over the terminal', () => {
    // The whole point: this is the touch the user actually makes — a rightward
    // drag starting at the left edge of the terminal — and before #1081 the
    // gate returned before the gesture began, so nothing happened.
    const { onIndexChange, result } = setup(1);

    drag(result, [2, 300], [2 + SWIPE_COMMIT_PX + 10, 300]);

    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('pulls Workspace in from the right band over the terminal', () => {
    const { onIndexChange, result } = setup(1);

    drag(result, [width - 2, 300], [width - 2 - SWIPE_COMMIT_PX - 10, 300]);

    expect(onIndexChange).toHaveBeenCalledWith(2);
  });

  it('starts a page on the band boundary and not one pixel further in', () => {
    // Pinned as a pair so the band's width is a decision the suite states
    // rather than a number the implementation happens to use.
    const onEdge = setup(1);
    drag(onEdge.result, [EDGE_BAND_PX, 300], [EDGE_BAND_PX + SWIPE_COMMIT_PX + 10, 300]);
    expect(onEdge.onIndexChange).toHaveBeenCalledWith(0);

    const past = setup(1);
    drag(past.result, [EDGE_BAND_PX + 1, 300], [EDGE_BAND_PX + 1 + SWIPE_COMMIT_PX + 10, 300]);
    expect(past.onIndexChange).not.toHaveBeenCalled();
    expect(past.result.current.isDragging).toBe(false);
  });

  it('gives the frame back when the drag moves the other way', () => {
    // Each edge owns one direction. A drag from the left edge going left is not
    // shell navigation — it is the shape of an xterm selection — so the shell
    // must let go rather than pull Workspace in from a start it does not own.
    const { onIndexChange, result } = setup(1);

    drag(result, [2, 300], [2 - (SWIPE_COMMIT_PX + 10), 300]);

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
    expect(result.current.isDragging).toBe(false);
  });

  it('gives the frame back when a drag reverses past its own start', () => {
    // The band constrains the net offset, not the opening move. A `0` here
    // would commit index+1 — Workspace, the layer the *opposite* edge owns —
    // from a drag that began at the left edge.
    const { onIndexChange, result } = setup(1);

    act(() => {
      result.current.onTouchStart(touchEvent(2, 300, xterm()));
      result.current.onTouchMove(touchEvent(2 + SWIPE_COMMIT_PX + 20, 300));
      result.current.onTouchMove(touchEvent(2 - 200, 300));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  it('keeps the axis lock: a vertical drag from the band scrolls', () => {
    const { onIndexChange, result } = setup(1);

    act(() => {
      result.current.onTouchStart(touchEvent(2, 100, xterm()));
      // 20px across, 160px down — a scroll that drifted sideways, started at
      // the edge. The band does not make this a page.
      result.current.onTouchMove(touchEvent(22, 260));
      result.current.onTouchMove(touchEvent(2 + 300, 260));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });

  it('measures the band from the shell, so an inset App still has edges', () => {
    // A 390px App inside a 1200px window: x = 2 is at the window's edge and
    // 180px outside the App, so it belongs to whatever is behind the App. The
    // App's own left edge is at 182.
    const inset: ShellBounds = { left: 182, right: 572 };

    const atShellEdge = setup(1, 3, inset);
    act(() => {
      atShellEdge.result.current.onTouchStart(touchEvent(184, 300, xterm()));
      atShellEdge.result.current.onTouchMove(touchEvent(184 + SWIPE_COMMIT_PX + 10, 300));
      atShellEdge.result.current.onTouchEnd();
    });
    expect(atShellEdge.onIndexChange).toHaveBeenCalledWith(0);

    const atWindowEdge = setup(1, 3, inset);
    act(() => {
      atWindowEdge.result.current.onTouchStart(touchEvent(2, 300, xterm()));
      atWindowEdge.result.current.onTouchMove(touchEvent(2 + SWIPE_COMMIT_PX + 10, 300));
      atWindowEdge.result.current.onTouchEnd();
    });
    expect(atWindowEdge.onIndexChange).not.toHaveBeenCalled();
  });

  it('declines a work-surface start when the shell cannot say where it ends', () => {
    // The surface wins the tie. `isWorkSurface` fails open for an unclassifiable
    // *target*; this is the other question — a classifiable target and an
    // unmeasurable shell — and there the shell has to prove its case.
    const { onIndexChange, result } = setup(1, 3, null);

    drag(result, [2, 300], [2 + SWIPE_COMMIT_PX + 10, 300]);

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
  });

  it('declines every start on a layer whose depth owns its leave (#1081)', () => {
    // The Workspace layer at a pushed detail. Not even shell chrome is the
    // shell's to page from there: the depth's page header carries the one leave
    // (#1051), and unlike the shell's it is allowed to refuse — Files' Back
    // blocks on an unsaved editor. A shell page from the same depth throws that
    // guard away, which is what the header swipe and the band both did.
    const { onIndexChange, result } = setup(2, 3, SHELL, false);

    // Chrome: the page header band, which the gate would otherwise allow.
    drag(result, [2, 300], [2 + SWIPE_COMMIT_PX + 10, 300], chrome());
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);

    // The work surface, from inside the band.
    drag(result, [2, 300], [2 - (SWIPE_COMMIT_PX + 10), 300], xterm());
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.isDragging).toBe(false);
  });

  it('still pages the same layer from its root, where nothing competes', () => {
    // The pair matters: standing down is scoped to a pushed detail, not to the
    // layer. At the Workspace root the shell's leave and Back go to the same
    // place — the Terminal — so there is nothing to compete over.
    const { onIndexChange, result } = setup(2, 3, SHELL, true);

    // Rightward, which from index 2 is the page back to the Terminal. (Leftward
    // from here runs off the end of the pager, so it is not a page at all —
    // which is why the suppression above removes the competing route and
    // nothing else.)
    drag(result, [2, 300], [2 + SWIPE_COMMIT_PX + 10, 300], chrome());

    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it('leaves an unconstrained start unconstrained even with bounds set', () => {
    // The band is only consulted for a touch inside a work surface. Chrome at
    // x = 2 — the same coordinate the band claims — pages in either direction.
    const { onIndexChange, result } = setup(1);

    drag(result, [2, 300], [2 - (SWIPE_COMMIT_PX + 10), 300], chrome());

    expect(onIndexChange).toHaveBeenCalledWith(2);
  });
});
