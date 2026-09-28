import {
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type PointerEventHandler,
  type RefObject,
} from 'react';

/** Pull distance that fills the ring and commits a load on release. */
export const TRANSCRIPT_PULL_TRIGGER_PX = 56;
const PULL_MAX_PX = 80;

function pullProgress(pullPx: number): number {
  return Math.min(1, pullPx / TRANSCRIPT_PULL_TRIGGER_PX);
}

/**
 * Top-edge pull-down to load older transcript pages (#1190). Progress fills a
 * ring; release above threshold commits `onCommitLoad`.
 */
export function useTranscriptPullToLoad({
  scrollRef,
  enabled,
  onCommitLoad,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onCommitLoad: () => void;
}) {
  const [pullPx, setPullPx] = useState(0);
  const pullingRef = useRef(false);
  const startYRef = useRef(0);
  const pullPxRef = useRef(0);

  const resetPull = useCallback(() => {
    pullingRef.current = false;
    pullPxRef.current = 0;
    setPullPx(0);
  }, []);

  const onPointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    const root = scrollRef.current;
    if (!enabled || !root || (event.button ?? 0) !== 0 || root.scrollTop > 0) {
      return;
    }
    pullingRef.current = true;
    startYRef.current = event.clientY;
    if (typeof root.setPointerCapture === 'function') {
      root.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!pullingRef.current) {
      return;
    }
    const root = scrollRef.current;
    if (!root || root.scrollTop > 0) {
      resetPull();
      return;
    }
    const delta = event.clientY - startYRef.current;
    if (delta <= 0) {
      pullPxRef.current = 0;
      setPullPx(0);
      return;
    }
    event.preventDefault();
    const next = Math.min(delta, PULL_MAX_PX);
    pullPxRef.current = next;
    setPullPx(next);
  };

  const finishPull = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!pullingRef.current) {
        return;
      }
      const root = scrollRef.current;
      if (root && typeof root.releasePointerCapture === 'function') {
        root.releasePointerCapture(event.pointerId);
      }
      const committed = pullPxRef.current >= TRANSCRIPT_PULL_TRIGGER_PX;
      resetPull();
      if (committed) {
        onCommitLoad();
      }
    },
    [onCommitLoad, resetPull, scrollRef],
  );

  return {
    pullPx,
    progress: pullProgress(pullPx),
    isPulling: pullPx > 0,
    pullHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishPull,
      onPointerCancel: finishPull,
    },
  };
}
