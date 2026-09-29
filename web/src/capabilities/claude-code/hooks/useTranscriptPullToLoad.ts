import {
  useCallback,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react';
import { useInstallTranscriptPullTouch } from './installTranscriptPullTouch';
import {
  createTranscriptPullPointerHandlers,
  createTranscriptPullWheelHandler,
} from './transcriptPullGestureHandlers';
import {
  TRANSCRIPT_PULL_MAX_PX,
  TRANSCRIPT_PULL_TRIGGER_PX,
  transcriptIsAtTopEdge,
  transcriptPullProgress,
} from './transcriptScrollConstants';

export { TRANSCRIPT_PULL_TRIGGER_PX } from './transcriptScrollConstants';

/**
 * Top-edge pull-down to load older transcript pages (#1190). Progress fills a
 * ring; release above threshold commits `onCommitLoad`.
 */
export function useTranscriptPullToLoad({
  scrollRef,
  pullHandleRef,
  enabled,
  onCommitLoad,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pullHandleRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onCommitLoad: () => void;
}) {
  const [pullPx, setPullPx] = useState(0);
  const [atTopEdge, setAtTopEdge] = useState(true);
  const pullingRef = useRef(false);
  const startYRef = useRef(0);
  const pullPxRef = useRef(0);
  const wheelPullRef = useRef(0);
  const onCommitLoadRef = useRef(onCommitLoad);
  onCommitLoadRef.current = onCommitLoad;

  const resetPull = useCallback(() => {
    pullingRef.current = false;
    pullPxRef.current = 0;
    wheelPullRef.current = 0;
    setPullPx(0);
  }, []);

  const applyPullPx = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(next, TRANSCRIPT_PULL_MAX_PX));
    pullPxRef.current = clamped;
    setPullPx(clamped);
  }, []);

  const commitIfFilled = useCallback(() => {
    const filled = pullPxRef.current >= TRANSCRIPT_PULL_TRIGGER_PX;
    resetPull();
    if (filled) {
      onCommitLoadRef.current();
    }
    return filled;
  }, [resetPull]);

  const syncTopEdge = useCallback(() => {
    const root = scrollRef.current;
    if (!root) {
      return;
    }
    setAtTopEdge(transcriptIsAtTopEdge(root));
  }, [scrollRef]);

  const beginPull = useCallback((clientY: number) => {
    pullingRef.current = true;
    startYRef.current = clientY;
  }, []);

  const movePull = useCallback(
    (clientY: number, preventDefault?: () => void) => {
      if (!pullingRef.current) {
        return;
      }
      const root = scrollRef.current;
      if (!root || !transcriptIsAtTopEdge(root)) {
        resetPull();
        return;
      }
      const delta = clientY - startYRef.current;
      if (delta <= 0) {
        applyPullPx(0);
        return;
      }
      preventDefault?.();
      applyPullPx(delta);
    },
    [applyPullPx, resetPull, scrollRef],
  );

  const finishPull = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!pullingRef.current) {
        return;
      }
      if (typeof event.currentTarget.releasePointerCapture === 'function') {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      commitIfFilled();
    },
    [commitIfFilled],
  );

  const pullHandleHandlers = createTranscriptPullPointerHandlers({
    enabled,
    beginPull,
    movePull,
    finishPull,
  });

  const onWheel = createTranscriptPullWheelHandler({
    scrollRef,
    enabled,
    wheelPullRef,
    applyPullPx,
    commitIfFilled,
  });

  const isAtTopEdge = useCallback(() => {
    const root = scrollRef.current;
    return root ? transcriptIsAtTopEdge(root) : false;
  }, [scrollRef]);

  useInstallTranscriptPullTouch({
    pullHandleRef,
    enabled,
    isAtTopEdge,
    beginPull,
    movePull,
    commitIfFilled,
  });

  return {
    pullPx,
    progress: transcriptPullProgress(pullPx),
    isPulling: pullPx > 0,
    atTopEdge,
    syncTopEdge,
    pullHandleHandlers,
    scrollHandlers: {
      onWheel,
    },
  };
}
