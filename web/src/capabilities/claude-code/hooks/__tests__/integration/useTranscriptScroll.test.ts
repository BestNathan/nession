import { renderHook, act } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useTranscriptScroll } from '../../useTranscriptScroll';

function scrollRoot(scrollHeight = 1000) {
  const el = document.createElement('div');
  let height = scrollHeight;
  Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true });
  el.scrollTop = 0;
  return { el, setScrollHeight: (next: number) => (height = next) };
}

describe('useTranscriptScroll', () => {
  it('honours a pull commit on a freshly opened conversation', () => {
    // The id arrives as null → real in the same commit that brings the first
    // items. A reset scheduled against that transition must not run after the
    // layout pass that marked the initial scroll done — when it did, every
    // older-page request on a fresh conversation was rejected.
    const onLoadOlder = vi.fn(() => true);
    const { el } = scrollRoot();

    const { result, rerender } = renderHook(
      ({ conversationId, itemCount }: { conversationId: string | null; itemCount: number }) =>
        useTranscriptScroll({
          conversationId,
          itemCount,
          hasMore: true,
          loadingOlder: false,
          onLoadOlder,
        }),
      { initialProps: { conversationId: null as string | null, itemCount: 0 } },
    );
    (result.current.scrollRef as MutableRefObject<HTMLDivElement | null>).current = el;

    rerender({ conversationId: 'c1', itemCount: 9 });
    // The initial placement puts the transcript at the bottom, away from the
    // top edge, so the initial pass itself must not have loaded.
    expect(onLoadOlder).not.toHaveBeenCalled();

    act(() => {
      result.current.loadOlderFromPull();
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending anchor across the spinner render and restores it when the page lands', async () => {
    // Committing a pull renders the spinner (`loadingOlder: true`) before the
    // page arrives. That render swaps the handle for the spinner — the scroll
    // height *shrinks* — so an anchor consumed there restores against the
    // wrong content and the actual prepend lands anchorless, jumping the
    // viewport. And the spinner render may lag the commit by whole tasks:
    // React defers the flush of wheel-event (continuous-lane) renders to the
    // scheduler, so anything that infers engagement from `loadingOlder` one
    // microtask later reads a false that is not the answer.
    const onLoadOlder = vi.fn(() => true);
    const { el, setScrollHeight } = scrollRoot(1000);

    const { result, rerender } = renderHook(
      ({
        conversationId,
        itemCount,
        loadingOlder,
      }: {
        conversationId: string | null;
        itemCount: number;
        loadingOlder: boolean;
      }) =>
        useTranscriptScroll({
          conversationId,
          itemCount,
          hasMore: true,
          loadingOlder,
          onLoadOlder,
        }),
      { initialProps: { conversationId: null as string | null, itemCount: 0, loadingOlder: false } },
    );
    (result.current.scrollRef as MutableRefObject<HTMLDivElement | null>).current = el;
    rerender({ conversationId: 'c1', itemCount: 9, loadingOlder: false });
    // The user scrolls to the top and pulls.
    act(() => {
      el.scrollTop = 0;
    });

    // The pull commits at the top: anchor captured against scrollHeight 1000,
    // and the fetch answers `engaged` synchronously — the controller keeps the
    // anchor on that answer alone.
    act(() => {
      result.current.loadOlderFromPull();
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // The wheel lane: the spinner's state update lands only after the
    // scheduler gets a turn — microtasks and macrotasks pass with
    // `loadingOlder` still false. The anchor must survive all of it.
    await act(async () => {});
    await act(async () => {});
    act(() => {
      setScrollHeight(950);
      rerender({ conversationId: 'c1', itemCount: 9, loadingOlder: true });
    });

    // The older page lands: the content stands 250 taller than at the
    // commit, so the viewport shifts down by exactly that to keep the same
    // messages in view.
    setScrollHeight(1250);
    rerender({ conversationId: 'c1', itemCount: 11, loadingOlder: false });

    expect(el.scrollTop).toBe(250);
  });

  it('restores against the gesture anchor the pull hands over, not the commit-time layout', () => {
    // At commit the pull has inflated the layout (handle grown, content
    // translated): a fresh measurement there is phantom. The controller must
    // prefer the anchor the gesture captured at its begin.
    const onLoadOlder = vi.fn(() => true);
    const { el, setScrollHeight } = scrollRoot(1000);

    const { result, rerender } = renderHook(
      ({
        conversationId,
        itemCount,
        loadingOlder,
      }: {
        conversationId: string | null;
        itemCount: number;
        loadingOlder: boolean;
      }) =>
        useTranscriptScroll({
          conversationId,
          itemCount,
          hasMore: true,
          loadingOlder,
          onLoadOlder,
        }),
      { initialProps: { conversationId: null as string | null, itemCount: 0, loadingOlder: false } },
    );
    (result.current.scrollRef as MutableRefObject<HTMLDivElement | null>).current = el;
    rerender({ conversationId: 'c1', itemCount: 9, loadingOlder: false });
    act(() => {
      el.scrollTop = 0;
    });

    // The gesture began against a resting layout of 1000; by commit the pull
    // has inflated it to 1100. A commit-time measurement would restore
    // against 1100; the handed-over anchor says 1000.
    setScrollHeight(1100);
    act(() => {
      result.current.loadOlderFromPull({ scrollHeight: 1000, scrollTop: 0 });
      setScrollHeight(1050);
      rerender({ conversationId: 'c1', itemCount: 9, loadingOlder: true });
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    setScrollHeight(1350);
    rerender({ conversationId: 'c1', itemCount: 11, loadingOlder: false });

    expect(el.scrollTop).toBe(350);
  });

  it('discards the pending anchor when the older fetch answers that nothing engaged', () => {
    // The engagement answer is synchronous on purpose: a fetch that never
    // started must not leave an anchor behind for the next prepend render to
    // consume against content it was never measured on.
    const onLoadOlder = vi.fn(() => false);
    const { el, setScrollHeight } = scrollRoot(1000);

    const { result, rerender } = renderHook(
      ({
        conversationId,
        itemCount,
        loadingOlder,
      }: {
        conversationId: string | null;
        itemCount: number;
        loadingOlder: boolean;
      }) =>
        useTranscriptScroll({
          conversationId,
          itemCount,
          hasMore: true,
          loadingOlder,
          onLoadOlder,
        }),
      { initialProps: { conversationId: null as string | null, itemCount: 0, loadingOlder: false } },
    );
    (result.current.scrollRef as MutableRefObject<HTMLDivElement | null>).current = el;
    rerender({ conversationId: 'c1', itemCount: 9, loadingOlder: false });
    act(() => {
      el.scrollTop = 0;
    });

    act(() => {
      result.current.loadOlderFromPull({ scrollHeight: 1000, scrollTop: 0 });
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // More items arrive without any older fetch (a live append): with no
    // anchor held over, the controller follows the latest instead of
    // restoring against the discarded one (which would land at 250).
    setScrollHeight(1250);
    rerender({ conversationId: 'c1', itemCount: 11, loadingOlder: false });

    expect(el.scrollTop).toBe(1250);
  });
});
