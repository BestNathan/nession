import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellBounds } from './edgeBand';
import { SWIPE_SETTLE_MS } from './gesture';
import type { InnerSwipeAction, SwipeEndResult, SwipeSnapshot } from './swipeGesture';

export interface SwipeSettleState {
  /** Where the preview renders while it animates to rest. */
  offset: number;
  /** The layer the gesture would have opened, kept mounted while it returns. */
  previewIndex: number | null;
  /** The layer to enter when the animation finishes, if this commit commits. */
  commitIndex: number | null;
  /**
   * The inner Workspace stack operation this contact resolved to (#3971). The
   * Workspace page follows this while it animates back to rest.
   */
  innerAction: InnerSwipeAction | null;
  /** The inner operation to run when the animation finishes, if any. */
  commitInnerAction: InnerSwipeAction | null;
  /** The inner destination's title, kept for the transient preview. */
  destinationLabel: string | null;
}

export interface UseSwipeSettleArgs {
  publish: () => void;
  onIndexChange: (index: number) => void;
  /** Run the capability's recorded inner-stack operation (#3971). */
  onInnerCommit: (action: InnerSwipeAction) => void;
  getShellBounds: () => ShellBounds | null;
  reducedMotion: boolean;
}

export interface UseSwipeSettleResult {
  settle: SwipeSettleState | null;
  /** Turn a release into a commit animation, a snapback, or an instant route. */
  complete: (end: SwipeEndResult, before: SwipeSnapshot) => void;
  /**
   * Finish the active settle now, applying its pending commit. Returns the
   * state that was finalized, or null when no settle was active.
   *
   * The rendered transition calls this when it ends; the timer is the bounded
   * fallback (reduced motion, a hidden tab, a browser that fires no event) and
   * a new contact uses it to catch up instead of being dropped (#4185).
   */
  finishSettle: () => SwipeSettleState | null;
  clearSettle: () => void;
}

type Ref<T> = { current: T };

function reportGesture(reason: string, detail: Record<string, unknown>): void {
  // Deliberately visible at the default console level: a physical-device
  // report needs to distinguish a native OS Back swipe (`native-touchcancel`,
  // `page-hidden`) from a threshold miss (`below-threshold`) without a debug
  // build. This is one line per completed contact.
  console.info('[app-swipe]', reason, detail);
}

/** The settle states a release can produce, kept outside the hook. */
function restState(
  innerAction: InnerSwipeAction,
  before: SwipeSnapshot,
): SwipeSettleState {
  return {
    offset: 0,
    previewIndex: null,
    commitIndex: null,
    innerAction,
    commitInnerAction: null,
    destinationLabel: before.destinationLabel,
  };
}

function pageCommitState(
  before: SwipeSnapshot,
  index: number,
  width: number,
): SwipeSettleState {
  return {
    offset: before.direction * width,
    previewIndex: index,
    commitIndex: index,
    innerAction: null,
    commitInnerAction: null,
    destinationLabel: null,
  };
}

function pageSnapbackState(before: SwipeSnapshot): SwipeSettleState {
  return {
    offset: 0,
    previewIndex: before.destinationIndex,
    commitIndex: null,
    innerAction: null,
    commitInnerAction: null,
    destinationLabel: null,
  };
}

interface CompleteContext {
  reducedRef: Ref<boolean>;
  onIndexChangeRef: Ref<(index: number) => void>;
  onInnerCommitRef: Ref<(action: InnerSwipeAction) => void>;
  getShellBoundsRef: Ref<() => ShellBounds | null>;
  beginSettle: (next: SwipeSettleState) => void;
  publish: () => void;
}

/**
 * Turn one release into a commit, a snapback, or an instant decision.
 *
 * Kept outside the hook so the React wrapper owns only refs and state; the
 * decision itself is the part #2724/#3971 own and can be read in one place.
 */
function completeSwipe(
  context: CompleteContext,
  end: SwipeEndResult,
  before: SwipeSnapshot,
): void {
  const {
    reducedRef,
    onIndexChangeRef,
    onInnerCommitRef,
    getShellBoundsRef,
    beginSettle,
    publish,
  } = context;

  reportGesture(end.reason, {
    outcome: end.outcome,
    travel: Math.round(end.travel),
    velocity: Number(end.velocity.toFixed(3)),
    threshold: Math.round(end.threshold),
    destination: end.destinationIndex,
    inner: end.innerAction,
  });

  if (end.outcome === 'none') {
    publish();
    return;
  }

  // An inner stack move is the capability's own guarded navigation, so a
  // commit runs at release; either outcome settles the Workspace frame from
  // the live offset. A rejected contact keeps its inner owner here: its return
  // is the same in-stack animation, never the outer layer's page snapback
  // (#4185). The capability's guard may refuse (dirty editor) — then the same
  // settle is the snapback and the depth stays.
  if (end.innerAction !== null) {
    if (end.outcome === 'commit') {
      onInnerCommitRef.current(end.innerAction);
    }
    if (before.offset === 0) {
      publish();
      return;
    }
    beginSettle(restState(end.innerAction, before));
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
      // An unmeasurable shell cannot animate; the route decision is still the
      // release's, so commit immediately rather than silently dropping a
      // gesture the engine judged deliberate.
      onIndexChangeRef.current(end.destinationIndex);
      publish();
      return;
    }
    // Move the current layer fully off-screen so the destination layer is at
    // rest. `AppLayers` gates visibility so the far-side neighbour cannot
    // flash while this runs (Workspace -> Terminal is the case).
    beginSettle(pageCommitState(before, end.destinationIndex, width));
    return;
  }

  if (before.offset === 0) {
    publish();
    return;
  }
  // A snapback still needs the layer it was previewing to stay mounted while
  // it returns to its parked position.
  beginSettle(pageSnapbackState(before));
}

/**
 * The release half of `useSwipePager` (#2724, #3971).
 *
 * Release is the only decision point: a committed navigation animates the
 * current layer fully off-screen before the route changes, and a cancelled one
 * animates the preview back, keeping the previewed layer mounted until it
 * returns. Reduced motion collapses both to an instant decision.
 *
 * An inner Workspace stack operation is decided and run at release. The page
 * then animates from the live under-finger offset back to rest: if the
 * capability accepted the Pop/Forward, the new depth is what paints; if its
 * guard refused (a dirty editor), the same animation is the snapback and the
 * depth stays. There is no second navigation authority here — the capability's
 * own guarded action is what runs.
 */
export function useSwipeSettle({
  publish,
  onIndexChange,
  onInnerCommit,
  getShellBounds,
  reducedMotion,
}: UseSwipeSettleArgs): UseSwipeSettleResult {
  const [settle, setSettle] = useState<SwipeSettleState | null>(null);
  const timerRef = useRef<number | null>(null);
  const serialRef = useRef(0);
  // The rendered state is not readable synchronously inside an event; the ref
  // is what lets a new contact catch up a settle that is still on screen.
  const settleRef = useRef<SwipeSettleState | null>(settle);
  settleRef.current = settle;

  // Timers and animation callbacks outlive the render that started them; read
  // the latest policy through refs rather than a stale closure.
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  const onInnerCommitRef = useRef(onInnerCommit);
  onInnerCommitRef.current = onInnerCommit;
  const getShellBoundsRef = useRef(getShellBounds);
  getShellBoundsRef.current = getShellBounds;

  const finalize = useCallback(
    (next: SwipeSettleState) => {
      settleRef.current = null;
      if (next.commitIndex !== null) {
        onIndexChangeRef.current(next.commitIndex);
      }
      if (next.commitInnerAction !== null) {
        onInnerCommitRef.current(next.commitInnerAction);
      }
      publish();
      setSettle(null);
    },
    [publish],
  );

  const finishSettle = useCallback((): SwipeSettleState | null => {
    const current = settleRef.current;
    if (current === null) {
      return null;
    }
    // Invalidate the fallback timer before finalizing; whichever of the
    // transition event, the timer, or a new contact gets here first owns the
    // single commit.
    serialRef.current += 1;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    finalize(current);
    return current;
  }, [finalize]);

  const clearSettle = useCallback(() => {
    serialRef.current += 1;
    settleRef.current = null;
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
      settleRef.current = next;
      setSettle(next);
      publish();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (serial !== serialRef.current) {
          return;
        }
        finalize(next);
      }, SWIPE_SETTLE_MS);
    },
    [finalize, publish],
  );

  const complete = useCallback(
    (end: SwipeEndResult, before: SwipeSnapshot) => {
      completeSwipe(
        {
          reducedRef,
          onIndexChangeRef,
          onInnerCommitRef,
          getShellBoundsRef,
          beginSettle,
          publish,
        },
        end,
        before,
      );
    },
    [beginSettle, publish],
  );

  return { settle, complete, finishSettle, clearSettle };
}
