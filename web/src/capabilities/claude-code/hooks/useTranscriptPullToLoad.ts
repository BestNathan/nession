import {
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type PointerEventHandler,
  type RefObject,
  type WheelEventHandler,
} from 'react';
import { TRANSCRIPT_TOP_EDGE_PX } from './transcriptScrollConstants';

/** Pull distance that fills the ring and commits a load on release. */
export const TRANSCRIPT_PULL_TRIGGER_PX = 56;
const PULL_MAX_PX = 80;

function pullProgress(pullPx: number): number {
  return Math.min(1, pullPx / TRANSCRIPT_PULL_TRIGGER_PX);
}

function isAtTopEdge(root: HTMLDivElement): boolean {
  return root.scrollTop <= TRANSCRIPT_TOP_EDGE_PX;
}

/**
 * Top-edge pull-down to load older transcript pages (#1190). Progress fills a
 * ring; release above threshold commits `onCommitLoad`. Wheel-up at the top
 * edge also fills the ring for trackpad users.
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
  const [atTopEdge, setAtTopEdge] = useState(true);
  const pullingRef = useRef(false);
  const startYRef = useRef(0);
  const pullPxRef = useRef(0);
  const wheelPullRef = useRef(0);

  const resetPull = useCallback(() => {
    pullingRef.current = false;
    pullPxRef.current = 0;
    wheelPullRef.current = 0;
    setPullPx(0);
  }, []);

  const applyPullPx = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(next, PULL_MAX_PX));
    pullPxRef.current = clamped;
    setPullPx(clamped);
  }, []);

  const commitIfFilled = useCallback(() => {
    if (pullPxRef.current >= TRANSCRIPT_PULL_TRIGGER_PX) {
      resetPull();
      onCommitLoad();
      return true;
    }
    resetPull();
    return false;
  }, [onCommitLoad, resetPull]);

  const syncTopEdge = useCallback(() => {
    const root = scrollRef.current;
    if (!root) {
      return;
    }
    setAtTopEdge(isAtTopEdge(root));
  }, [scrollRef]);

  const onPointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    const root = scrollRef.current;
    if (!enabled || !root || (event.button ?? 0) !== 0 || !isAtTopEdge(root)) {
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
    if (!root || !isAtTopEdge(root)) {
      resetPull();
      return;
    }
    const delta = event.clientY - startYRef.current;
    if (delta <= 0) {
      applyPullPx(0);
      return;
    }
    event.preventDefault();
    applyPullPx(delta);
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
      commitIfFilled();
    },
    [commitIfFilled, scrollRef],
  );

  const onWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    const root = scrollRef.current;
    if (!enabled || !root || !isAtTopEdge(root) || event.deltaY >= 0) {
      return;
    }
    event.preventDefault();
    wheelPullRef.current = Math.min(
      PULL_MAX_PX,
      wheelPullRef.current + Math.min(24, Math.abs(event.deltaY)),
    );
    applyPullPx(wheelPullRef.current);
    if (wheelPullRef.current >= TRANSCRIPT_PULL_TRIGGER_PX) {
      commitIfFilled();
    }
  };

  return {
    pullPx,
    progress: pullProgress(pullPx),
    isPulling: pullPx > 0,
    atTopEdge,
    syncTopEdge,
    pullHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishPull,
      onPointerCancel: finishPull,
      onWheel,
    },
  };
}
