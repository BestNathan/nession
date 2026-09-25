import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TouchEvent } from 'react';
import { SWIPE_COMMIT_PX } from '../../gesture';
import { useSwipePager } from '../../useSwipePager';

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

  function setup(index: number, pageCount = 3) {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipePager({ pageCount, index, onIndexChange }),
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
    // The gesture keeps its whole width: what bounds it is where it may start
    // (`workSurface.ts`), not a strip at the screen edge. #473 asked for an
    // edge band, #748 rejected it as undiscoverable, and #1049 settled it as a
    // start gate instead of a band.
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

describe('useSwipePager — top-level navigation is bounded by work-surface exclusion', () => {
  const width = 400;

  function setup(index: number, pageCount = 3) {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useSwipePager({ pageCount, index, onIndexChange }),
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
