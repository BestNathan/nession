import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellBounds } from './edgeBand';
import { SWIPE_SETTLE_MS } from './gesture';
import type { SwipeEndResult, SwipeSnapshot } from './swipeGesture';

export interface SwipeSettleState {
  /** Where the preview renders while it animates to rest. */
  offset: number;
  /** The layer the gesture would have opened, kept mounted while it returns. */
  previewIndex: number | null;
  /** The layer to enter when the animation finishes, if this commit commits. */
  commitIndex: number | null;
}

export interface UseSwipeSettleArgs {
  publish: () => void;
  onIndexChange: (index: number) => void;
  getShellBounds: () => ShellBounds | null;
  reducedMotion: boolean;
}

export interface UseSwipeSettleResult {
  settle: SwipeSettleState | null;
  /** Turn a release into a commit animation, a snapback, or an instant route. */
  complete: (end: SwipeEndResult, before: SwipeSnapshot) => void;
  clearSettle: () => void;
}

function reportGesture(reason: string, detail: Record<string, unknown>): void {
  // Deliberately visible at the default console level: a physical-device
  // report needs to distinguish a native OS Back swipe (`native-touchcancel`,
  // `page-hidden`) from a threshold miss (`below-threshold`) without a debug
  // build. This is one line per completed contact.
  console.info('[app-swipe]', reason, detail);
}

/**
 * The release half of `useSwipePager` (#2724).
 *
 * Release is the only decision point: a committed navigation animates the
 * current layer fully off-screen before the route changes, and a cancelled one
 * animates the preview back, keeping the previewed layer mounted until it
 * returns. Reduced motion collapses both to an instant decision.
 */
export function useSwipeSettle({
  publish,
  onIndexChange,
  getShellBounds,
  reducedMotion,
}: UseSwipeSettleArgs): UseSwipeSettleResult {
  const [settle, setSettle] = useState<SwipeSettleState | null>(null);
  const timerRef = useRef<number | null>(null);
  const serialRef = useRef(0);

  // Timers and animation callbacks outlive the render that started them; read
  // the latest policy through refs rather than a stale closure.
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  const getShellBoundsRef = useRef(getShellBounds);
  getShellBoundsRef.current = getShellBounds;

  const clearSettle = useCallback(() => {
    serialRef.current += 1;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSettle(null);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  const beginSettle = useCallback(
    (next: SwipeSettleState) => {
      const serial = serialRef.current + 1;
      serialRef.current = serial;
      setSettle(next);
      publish();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (serial !== serialRef.current) {
          return;
        }
        if (next.commitIndex !== null) {
          onIndexChangeRef.current(next.commitIndex);
        }
        publish();
        setSettle(null);
      }, SWIPE_SETTLE_MS);
    },
    [publish],
  );

  const complete = useCallback(
    (end: SwipeEndResult, before: SwipeSnapshot) => {
      reportGesture(end.reason, {
        outcome: end.outcome,
        travel: Math.round(end.travel),
        velocity: Number(end.velocity.toFixed(3)),
        threshold: Math.round(end.threshold),
        destination: end.destinationIndex,
      });

      if (end.outcome === 'none') {
        publish();
        return;
      }

      if (reducedRef.current) {
        if (end.outcome === 'commit' && end.destinationIndex !== null) {
          onIndexChangeRef.current(end.destinationIndex);
        }
        publish();
        return;
      }

      const bounds = getShellBoundsRef.current();
      const width = bounds === null ? 0 : Math.max(0, bounds.right - bounds.left);
      if (end.outcome === 'commit' && end.destinationIndex !== null) {
        if (before.direction === 0 || width <= 0) {
          // An unmeasurable shell cannot animate; the route decision is still
          // the release's, so commit immediately rather than silently dropping
          // a gesture the engine judged deliberate.
          onIndexChangeRef.current(end.destinationIndex);
          publish();
          return;
        }
        // Move the current layer fully off-screen so the destination layer is
        // at rest. `AppLayers` gates visibility so the far-side neighbour
        // cannot flash while this runs (Workspace -> Terminal is the case).
        beginSettle({
          offset: before.direction * width,
          previewIndex: end.destinationIndex,
          commitIndex: end.destinationIndex,
        });
        return;
      }

      if (before.offset === 0) {
        publish();
        return;
      }
      // A snapback still needs the layer it was previewing to stay mounted
      // while it returns to its parked position; otherwise release would
      // unmount the preview in one frame instead of animating it shut.
      beginSettle({
        offset: 0,
        previewIndex: before.destinationIndex,
        commitIndex: null,
      });
    },
    [beginSettle, publish],
  );

  return { settle, complete, clearSettle };
}
