import { renderHook, act } from '@testing-library/react';
import { type PointerEventHandler, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  TRANSCRIPT_PULL_TRIGGER_PX,
  useTranscriptPullToLoad,
} from '../../useTranscriptPullToLoad';

type PullPointerEvent = Parameters<PointerEventHandler<HTMLDivElement>>[0];

function pointerProps(clientY: number, pointerId = 1) {
  return {
    clientY,
    pointerId,
    button: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function refs() {
  const scrollEl = document.createElement('div');
  scrollEl.scrollTop = 0;
  const handleEl = document.createElement('div');
  return {
    scrollRef: { current: scrollEl } as RefObject<HTMLDivElement>,
    pullHandleRef: { current: handleEl } as RefObject<HTMLDivElement>,
    handleEl,
  };
}

describe('useTranscriptPullToLoad', () => {
  it('commits load when pull passes the trigger threshold', () => {
    const onCommitLoad = vi.fn();
    const { scrollRef, pullHandleRef, handleEl } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, pullHandleRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      result.current.pullHandleHandlers.onPointerDown({
        ...pointerProps(100),
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandleHandlers.onPointerMove({
        ...pointerProps(100 + TRANSCRIPT_PULL_TRIGGER_PX),
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandleHandlers.onPointerUp({
        pointerId: 1,
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });

    expect(onCommitLoad).toHaveBeenCalledTimes(1);
  });

  it('does not commit when pull is released below the trigger threshold', () => {
    const onCommitLoad = vi.fn();
    const { scrollRef, pullHandleRef, handleEl } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, pullHandleRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      result.current.pullHandleHandlers.onPointerDown({
        ...pointerProps(100),
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandleHandlers.onPointerMove({
        ...pointerProps(130),
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandleHandlers.onPointerUp({
        pointerId: 1,
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });

    expect(onCommitLoad).not.toHaveBeenCalled();
  });

  it('commits load when the wheel overscrolls at the top edge', () => {
    const onCommitLoad = vi.fn();
    const { scrollRef, pullHandleRef } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, pullHandleRef, enabled: true, onCommitLoad }),
    );

    const wheelEvent = {
      deltaY: -20,
      preventDefault: vi.fn(),
      currentTarget: scrollRef.current,
    } as unknown as Parameters<NonNullable<typeof result.current.scrollHandlers.onWheel>>[0];
    act(() => {
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
    });

    expect(onCommitLoad).toHaveBeenCalledTimes(1);
  });
});
