import {
  useCallback,
  useRef,
  useState,
  type MutableRefObject,
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
  type TranscriptAnchor,
} from './transcriptScrollConstants';

export { TRANSCRIPT_PULL_TRIGGER_PX } from './transcriptScrollConstants';

/**
 * The pull gesture's state machine: how far the ring has filled, in which
 * gesture (pointer or wheel — they share one fill), and the anchor captured
 * when the current gesture began.
 *
 * The anchor belongs to the gesture, not to the commit: mid-gesture the
 * layout is inflated by the pull itself (the handle grows, the content
 * translates), so a commit-time measurement would be phantom. `resetPull`
 * clears it so one gesture's anchor never leaks into the next.
 */
function usePullGestureState({
  scrollRef,
  onCommitLoadRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  onCommitLoadRef: MutableRefObject<(anchor: TranscriptAnchor | null) => void>;
}) {
  const [pullPx, setPullPx] = useState(0);
  const pullingRef = useRef(false);
  const startYRef = useRef(0);
  const pullPxRef = useRef(0);
  const wheelPullRef = useRef(0);
  const gestureAnchorRef = useRef<TranscriptAnchor | null>(null);

  const captureGestureAnchor = useCallback(() => {
    const root = scrollRef.current;
    gestureAnchorRef.current = root
      ? { scrollHeight: root.scrollHeight, scrollTop: root.scrollTop }
      : null;
  }, [scrollRef]);

  const resetPull = useCallback(() => {
    pullingRef.current = false;
    pullPxRef.current = 0;
    wheelPullRef.current = 0;
    gestureAnchorRef.current = null;
    setPullPx(0);
  }, []);

  const applyPullPx = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(next, TRANSCRIPT_PULL_MAX_PX));
    pullPxRef.current = clamped;
    setPullPx(clamped);
  }, []);

  const commitIfFilled = useCallback(() => {
    const filled = pullPxRef.current >= TRANSCRIPT_PULL_TRIGGER_PX;
    // Read before resetPull clears it: the anchor belongs to this gesture
    // and must not leak into a later request.
    const anchor = gestureAnchorRef.current;
    resetPull();
    if (filled) {
      onCommitLoadRef.current(anchor);
    }
    return filled;
  }, [onCommitLoadRef, resetPull]);

  const beginPull = useCallback(
    (clientY: number) => {
      // A gesture that starts on an already-filled ring continues the wheel
      // gesture that filled it — whose clean anchor is already captured.
      if (pullPxRef.current === 0) {
        captureGestureAnchor();
      }
      pullingRef.current = true;
      startYRef.current = clientY;
    },
    [captureGestureAnchor],
  );

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

  return {
    pullPx,
    wheelPullRef,
    gestureAnchorRef,
    applyPullPx,
    beginPull,
    movePull,
    finishPull,
    commitIfFilled,
  };
}

/**
 * Top-edge pull-down to load older transcript pages (#1190). Progress fills a
 * ring; release above threshold commits `onCommitLoad` with the anchor
 * captured when the gesture began.
 */
export function useTranscriptPullToLoad({
  scrollRef,
  pullHandle,
  enabled,
  onCommitLoad,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pullHandle: HTMLDivElement | null;
  enabled: boolean;
  onCommitLoad: (anchor: TranscriptAnchor | null) => void;
}) {
  const onCommitLoadRef = useRef(onCommitLoad);
  onCommitLoadRef.current = onCommitLoad;
  const {
    pullPx,
    wheelPullRef,
    gestureAnchorRef,
    applyPullPx,
    beginPull,
    movePull,
    finishPull,
    commitIfFilled,
  } = usePullGestureState({ scrollRef, onCommitLoadRef });
  const [atTopEdge, setAtTopEdge] = useState(true);

  const syncTopEdge = useCallback(() => {
    const root = scrollRef.current;
    if (!root) {
      return;
    }
    setAtTopEdge(transcriptIsAtTopEdge(root));
  }, [scrollRef]);

  const isAtTopEdge = useCallback(() => {
    const root = scrollRef.current;
    return root ? transcriptIsAtTopEdge(root) : false;
  }, [scrollRef]);

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
    gestureAnchorRef,
    applyPullPx,
    commitIfFilled,
  });

  useInstallTranscriptPullTouch({
    pullHandle,
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
