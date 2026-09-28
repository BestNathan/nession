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
  };
}

describe('useTranscriptPullToLoad', () => {
  it('commits load when pull passes the trigger threshold', () => {
    const onCommitLoad = vi.fn();
    const scrollEl = document.createElement('div');
    scrollEl.scrollTop = 0;
    const scrollRef = { current: scrollEl } as RefObject<HTMLDivElement>;

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      result.current.pullHandlers.onPointerDown({
        ...pointerProps(100),
        currentTarget: scrollEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandlers.onPointerMove({
        ...pointerProps(100 + TRANSCRIPT_PULL_TRIGGER_PX),
        currentTarget: scrollEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandlers.onPointerUp({
        pointerId: 1,
        currentTarget: scrollEl,
      } as unknown as PullPointerEvent);
    });

    expect(onCommitLoad).toHaveBeenCalledTimes(1);
  });

  it('does not commit when pull is released below the trigger threshold', () => {
    const onCommitLoad = vi.fn();
    const scrollEl = document.createElement('div');
    scrollEl.scrollTop = 0;
    const scrollRef = { current: scrollEl } as RefObject<HTMLDivElement>;

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      result.current.pullHandlers.onPointerDown({
        ...pointerProps(100),
        currentTarget: scrollEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandlers.onPointerMove({
        ...pointerProps(130),
        currentTarget: scrollEl,
      } as unknown as PullPointerEvent);
    });
    act(() => {
      result.current.pullHandlers.onPointerUp({
        pointerId: 1,
        currentTarget: scrollEl,
      } as unknown as PullPointerEvent);
    });

    expect(onCommitLoad).not.toHaveBeenCalled();
  });
});
