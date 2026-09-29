import { useEffect } from 'react';

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

/**
 * The handle is conditionally rendered — it unmounts every time the
 * transcript leaves the top edge and mounts fresh on return. A
 * `RefObject`-based effect never re-runs for the new node (all its deps are
 * stable), so the first unmount permanently killed the touch gesture. Taking
 * the *node* (from a callback ref stored in state) makes the effect re-run
 * per node: every mounted handle gets its own listeners.
 */
export function useInstallTranscriptPullTouch({
  pullHandle,
  enabled,
  isAtTopEdge,
  beginPull,
  movePull,
  commitIfFilled,
}: {
  pullHandle: HTMLDivElement | null;
  enabled: boolean;
} & PullTouchCallbacks): void {
  useEffect(() => {
    if (!enabled || !pullHandle) {
      return;
    }
    return installTranscriptPullTouch(pullHandle, {
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
    pullHandle,
  ]);
}
