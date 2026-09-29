import { useEffect, type RefObject } from 'react';

type PullTouchCallbacks = {
  isAtTopEdge: () => boolean;
  beginPull: (clientY: number) => void;
  movePull: (clientY: number, preventDefault: () => void) => void;
  commitIfFilled: () => void;
};

/** Non-passive touchmove on the pull handle so mobile browsers honor the gesture. */
export function installTranscriptPullTouch(
  handle: HTMLDivElement,
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

  handle.addEventListener('touchstart', onTouchStart, { passive: true });
  handle.addEventListener('touchmove', onTouchMove, { passive: false });
  handle.addEventListener('touchend', onTouchEnd);
  handle.addEventListener('touchcancel', onTouchEnd);

  return () => {
    handle.removeEventListener('touchstart', onTouchStart);
    handle.removeEventListener('touchmove', onTouchMove);
    handle.removeEventListener('touchend', onTouchEnd);
    handle.removeEventListener('touchcancel', onTouchEnd);
  };
}

export function useInstallTranscriptPullTouch({
  pullHandleRef,
  enabled,
  isAtTopEdge,
  beginPull,
  movePull,
  commitIfFilled,
}: {
  pullHandleRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
} & PullTouchCallbacks): void {
  useEffect(() => {
    const handle = pullHandleRef.current;
    if (!enabled || !handle) {
      return;
    }
    return installTranscriptPullTouch(handle, {
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
    pullHandleRef,
  ]);
}
