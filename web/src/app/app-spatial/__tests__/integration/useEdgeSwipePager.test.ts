import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TouchEvent } from 'react';
import { EDGE_BAND_PX } from '../../edgeBand';
import { useEdgeSwipePager } from '../../useEdgeSwipePager';

function touchEvent(clientX: number, clientY = 0): TouchEvent {
  return {
    touches: [{ clientX, clientY } as Touch],
  } as unknown as TouchEvent;
}

describe('EDGE_BAND_PX', () => {
  it('equals 24', () => {
    expect(EDGE_BAND_PX).toBe(24);
  });
});

describe('useEdgeSwipePager', () => {
  const width = 400;

  it('ignores non-edge touch starts', () => {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({
        pageCount: 3,
        index: 1,
        onIndexChange,
        width,
      }),
    );

    act(() => {
      result.current.onTouchStart(touchEvent(width / 2));
      result.current.onTouchMove(touchEvent(width / 2 + 100));
      result.current.onTouchEnd();
    });

    expect(result.current.dragOffset).toBe(0);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('commits index-1 on left-edge drag right', () => {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({
        pageCount: 3,
        index: 1,
        onIndexChange,
        width,
      }),
    );

    act(() => {
      result.current.onTouchStart(touchEvent(10));
      result.current.onTouchMove(touchEvent(10 + 90));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).toHaveBeenCalledWith(0);
    expect(result.current.dragOffset).toBe(0);
  });

  it('commits index+1 on right-edge drag left', () => {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({
        pageCount: 3,
        index: 1,
        onIndexChange,
        width,
      }),
    );

    act(() => {
      result.current.onTouchStart(touchEvent(width - 10));
      result.current.onTouchMove(touchEvent(width - 10 - 90));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).toHaveBeenCalledWith(2);
    expect(result.current.dragOffset).toBe(0);
  });

  it('does not call onIndexChange when dragging right at index 0', () => {
    const onIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipePager({
        pageCount: 3,
        index: 0,
        onIndexChange,
        width,
      }),
    );

    act(() => {
      result.current.onTouchStart(touchEvent(10));
      result.current.onTouchMove(touchEvent(10 + 90));
      result.current.onTouchEnd();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(result.current.dragOffset).toBe(0);
  });
});
