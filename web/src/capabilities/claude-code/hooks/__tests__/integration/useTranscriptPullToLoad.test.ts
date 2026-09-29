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
    handleEl,
  };
}

describe('useTranscriptPullToLoad', () => {
  it('commits load when pull passes the trigger threshold', () => {
    const onCommitLoad = vi.fn();
    const { scrollRef, handleEl } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
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
    const { scrollRef, handleEl } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
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
    // Four full wheel ticks: each contributes the capped 24px step, so the
    // ring reaches the 96px trigger exactly — a deliberate overscroll.
    const onCommitLoad = vi.fn();
    const { scrollRef } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    const wheelEvent = {
      deltaY: -30,
      preventDefault: vi.fn(),
      currentTarget: scrollRef.current,
    } as unknown as Parameters<NonNullable<typeof result.current.scrollHandlers.onWheel>>[0];
    act(() => {
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
    });

    expect(onCommitLoad).toHaveBeenCalledTimes(1);
  });

  it('does not commit a casual overscroll that stops short of the trigger', () => {
    // Three wheel ticks accumulate 60px — the exact gesture that committed at
    // the old 56px trigger. Under the 96px trigger it must fill the ring
    // partially and commit nothing.
    const onCommitLoad = vi.fn();
    const { scrollRef } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
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

    expect(result.current.pullPx).toBeGreaterThan(0);
    expect(result.current.pullPx).toBeLessThan(TRANSCRIPT_PULL_TRIGGER_PX);
    expect(onCommitLoad).not.toHaveBeenCalled();
  });

  it('does not fill or commit when wheeling toward newer messages at the top edge', () => {
    // deltaY > 0 is toward *newer* content — an ordinary scroll that goes
    // nowhere at the exact top, never a pull.
    const onCommitLoad = vi.fn();
    const { scrollRef } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    const wheelDown = {
      deltaY: 20,
      preventDefault: vi.fn(),
      currentTarget: scrollRef.current,
    } as unknown as Parameters<NonNullable<typeof result.current.scrollHandlers.onWheel>>[0];
    act(() => {
      result.current.scrollHandlers.onWheel(wheelDown);
      result.current.scrollHandlers.onWheel(wheelDown);
      result.current.scrollHandlers.onWheel(wheelDown);
    });

    expect(result.current.pullPx).toBe(0);
    expect(onCommitLoad).not.toHaveBeenCalled();
  });

  it('drains a partial wheel pull when the gesture reverses direction', () => {
    const onCommitLoad = vi.fn();
    const { scrollRef } = refs();

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    const wheel = (deltaY: number) =>
      ({
        deltaY,
        preventDefault: vi.fn(),
        currentTarget: scrollRef.current,
      }) as unknown as Parameters<NonNullable<typeof result.current.scrollHandlers.onWheel>>[0];
    act(() => {
      // 40px of pull, then a reversal that must drain it…
      result.current.scrollHandlers.onWheel(wheel(-20));
      result.current.scrollHandlers.onWheel(wheel(-20));
      result.current.scrollHandlers.onWheel(wheel(20));
      // …so the next 40px starts from zero and stays below the trigger.
      result.current.scrollHandlers.onWheel(wheel(-20));
      result.current.scrollHandlers.onWheel(wheel(-20));
    });

    expect(result.current.pullPx).toBe(40);
    expect(onCommitLoad).not.toHaveBeenCalled();
  });

  it('commits with the anchor captured when the gesture began, not the inflated mid-gesture layout', () => {
    // The pull inflates the scroll height as it fills (the handle grows, the
    // content translates), so an anchor measured at commit would restore
    // against phantom pixels.
    const onCommitLoad = vi.fn();
    const scrollEl = document.createElement('div');
    scrollEl.scrollTop = 0;
    let scrollHeight = 1000;
    Object.defineProperty(scrollEl, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    });
    const scrollRef = { current: scrollEl } as RefObject<HTMLDivElement>;
    const handleEl = document.createElement('div');

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      result.current.pullHandleHandlers.onPointerDown({
        ...pointerProps(100),
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });
    // The gesture fills; the layout inflates with it.
    scrollHeight = 1100;
    act(() => {
      result.current.pullHandleHandlers.onPointerMove({
        ...pointerProps(100 + TRANSCRIPT_PULL_TRIGGER_PX),
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
      result.current.pullHandleHandlers.onPointerUp({
        pointerId: 1,
        currentTarget: handleEl,
      } as unknown as PullPointerEvent);
    });

    expect(onCommitLoad).toHaveBeenCalledWith({ scrollHeight: 1000, scrollTop: 0 });
  });

  it('captures the wheel gesture anchor at the first fill', () => {
    const onCommitLoad = vi.fn();
    const scrollEl = document.createElement('div');
    scrollEl.scrollTop = 0;
    let scrollHeight = 1000;
    Object.defineProperty(scrollEl, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    });
    const scrollRef = { current: scrollEl } as RefObject<HTMLDivElement>;

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    const wheelEvent = {
      deltaY: -30,
      preventDefault: vi.fn(),
      currentTarget: scrollEl,
    } as unknown as Parameters<NonNullable<typeof result.current.scrollHandlers.onWheel>>[0];
    act(() => {
      result.current.scrollHandlers.onWheel(wheelEvent);
      scrollHeight = 1100;
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
      result.current.scrollHandlers.onWheel(wheelEvent);
    });

    expect(onCommitLoad).toHaveBeenCalledWith({ scrollHeight: 1000, scrollTop: 0 });
  });

  it('commits when a touch drag pulls down on the feed at the top edge', () => {
    // The touch gesture lives on the scroll root: a drag anywhere on the
    // feed pulls, not only a drag that lands on the hint bar.
    const onCommitLoad = vi.fn();
    const { scrollRef } = refs();

    renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      const root = scrollRef.current!;
      root.dispatchEvent(
        Object.assign(new Event('touchstart'), { touches: [{ clientY: 100 }] }),
      );
      root.dispatchEvent(
        Object.assign(new Event('touchmove'), {
          touches: [{ clientY: 100 + TRANSCRIPT_PULL_TRIGGER_PX + 10 }],
        }),
      );
      root.dispatchEvent(new Event('touchend'));
    });

    expect(onCommitLoad).toHaveBeenCalledTimes(1);
  });

  it('still pulls when the touch drag starts on the hint bar itself', () => {
    // The hint bar is a child of the scroll root; its touches must bubble up
    // to the same gesture.
    const onCommitLoad = vi.fn();
    const { scrollRef, handleEl } = refs();
    scrollRef.current!.appendChild(handleEl);

    renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      handleEl.dispatchEvent(
        Object.assign(new Event('touchstart', { bubbles: true }), {
          touches: [{ clientY: 100 }],
        }),
      );
      handleEl.dispatchEvent(
        Object.assign(new Event('touchmove', { bubbles: true }), {
          touches: [{ clientY: 100 + TRANSCRIPT_PULL_TRIGGER_PX + 10 }],
        }),
      );
      handleEl.dispatchEvent(new Event('touchend', { bubbles: true }));
    });

    expect(onCommitLoad).toHaveBeenCalledTimes(1);
  });

  it('does not pull when the touch gesture starts away from the top edge', () => {
    // A pull must start at the top: a drag that begins mid-feed and scrolls
    // up *into* the top edge inside the same gesture is still an ordinary
    // scroll, not a pull — otherwise every fast upward flick that reaches
    // the top would hijack the gesture's tail into a load.
    const onCommitLoad = vi.fn();
    const { scrollRef } = refs();
    scrollRef.current!.scrollTop = 300;

    const { result } = renderHook(() =>
      useTranscriptPullToLoad({ scrollRef, enabled: true, onCommitLoad }),
    );

    act(() => {
      const root = scrollRef.current!;
      root.dispatchEvent(
        Object.assign(new Event('touchstart'), { touches: [{ clientY: 400 }] }),
      );
      // Scroll up into the top edge…
      root.dispatchEvent(
        Object.assign(new Event('touchmove'), { touches: [{ clientY: 100 }] }),
      );
      scrollRef.current!.scrollTop = 0;
      // …then drag back down past the gesture's start.
      root.dispatchEvent(
        Object.assign(new Event('touchmove'), { touches: [{ clientY: 450 }] }),
      );
      root.dispatchEvent(new Event('touchend'));
    });

    expect(result.current.pullPx).toBe(0);
    expect(onCommitLoad).not.toHaveBeenCalled();
  });
});
