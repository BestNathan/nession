import { useEffect, type RefObject } from 'react';

type PullTouchCallbacks = {
  isAtTopEdge: () => boolean;
  beginPull: (clientY: number) => void;
  movePull: (clientY: number, preventDefault: () => void) => void;
  commitIfFilled: () => void;
};

/**
 * Non-passive touchmove on the scroll root, so a downward drag anywhere on
 * the feed fills the pull ring — not only a drag that lands on the hint bar.
 * The hint bar lives inside the root, so its touches bubble up here too.
 * `preventDefault` is what lets the pull own the gesture over the
 * container's native scroll; it only fires once the drag moves down past
 * its start, so an upward flick at the top edge still scrolls normally.
 */
export function installTranscriptPullTouch(
  root: HTMLDivElement,
  callbacks: PullTouchCallbacks,
): () => void {
  let touchStartY = 0;
  let touchPulling = false;

  const onTouchStart = (event: TouchEvent) => {
    if (!callbacks.isAtTopEdge() || event.touches.length !== 1) {
      return;
    }
    touchStartY = event.touches[0].clientY;
    touchPulling = true;
    callbacks.beginPull(touchStartY);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!touchPulling || event.touches.length !== 1) {
      return;
    }
    callbacks.movePull(event.touches[0].clientY, () => event.preventDefault());
  };

  const onTouchEnd = () => {
    if (!touchPulling) {
      return;
    }
    touchPulling = false;
    callbacks.commitIfFilled();
  };

  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd);
  root.addEventListener('touchcancel', onTouchEnd);

  return () => {
    root.removeEventListener('touchstart', onTouchStart);
    root.removeEventListener('touchmove', onTouchMove);
    root.removeEventListener('touchend', onTouchEnd);
    root.removeEventListener('touchcancel', onTouchEnd);
  };
}

/**
 * The listeners live on the scroll root, which — unlike the conditionally
 * rendered hint bar — never unmounts while the transcript is on screen, so
 * a ref read in the effect is enough; there is no per-node re-install to
 * arrange.
 */
export function useInstallTranscriptPullTouch({
  scrollRef,
  enabled,
  isAtTopEdge,
  beginPull,
  movePull,
  commitIfFilled,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
} & PullTouchCallbacks): void {
  useEffect(() => {
    const root = scrollRef.current;
    if (!enabled || !root) {
      return;
    }
    return installTranscriptPullTouch(root, {
      isAtTopEdge,
      beginPull,
      movePull,
      commitIfFilled,
    });
  }, [
    beginPull,
    commitIfFilled,
    enabled,
    isAtTopEdge,
    movePull,
    scrollRef,
  ]);
}
