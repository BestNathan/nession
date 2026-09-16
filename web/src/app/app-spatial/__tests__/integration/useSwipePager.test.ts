import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TouchEvent } from 'react';
import { SWIPE_COMMIT_PX } from '../../gesture';
import { useSwipePager } from '../../useSwipePager';

function touchEvent(clientX: number, clientY = 0): TouchEvent {
  return {
    touches: [{ clientX, clientY } as Touch],
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
  ) {
    act(() => {
      result.current.onTouchStart(touchEvent(from[0], from[1]));
      result.current.onTouchMove(touchEvent(to[0], to[1]));
      result.current.onTouchEnd();
    });
  }

  it('turns the page from a drag that starts anywhere on the surface', () => {
    // The gate is the axis lock, not a start position: `interaction/app.md`
    // says "swipe right from the Terminal surface" — the whole surface. An
    // edge band would have narrowed that to a strip and made it undiscoverable.
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
      result.current.onTouchStart(touchEvent(width / 2, 100));
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
      result.current.onTouchStart(touchEvent(width / 2, 300));
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
