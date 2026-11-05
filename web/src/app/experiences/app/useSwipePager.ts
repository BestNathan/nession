import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import { subscribeTouchOwnership } from '@/shared/lib/touchOwnership';
import type { ShellBounds } from './edgeBand';
import { SwipeGesture, type SwipePhase, type SwipeSnapshot } from './swipeGesture';
import { bindSwipeTouchListeners } from './swipeTouchBinding';
import { useSwipeSettle, type SwipeSettleState } from './useSwipeSettle';

export interface UseSwipePagerArgs {
  pageCount: number;
  index: number;
  onIndexChange: (index: number) => void;
  /**
   * The shell's horizontal extent in client coordinates, read once per touch —
   * the frame the edge band and the commit threshold are measured from
   * (#1081, #2724). A callback rather than a value because the shell can move
   * and resize, and a `null` return means the shell cannot say where its edges
   * are; a touch inside a work surface then does not start a page, since the
   * surface wins when the shell cannot show the touch was at its edge.
   */
  getShellBounds: () => ShellBounds | null;
  /**
   * Whether the shell may claim a horizontal drag on this layer at all (#1081).
   *
   * False while the layer's own depth is offering a leave. The App has one
   * such depth: a pushed Workspace detail, whose page header's Back is that
   * depth's single leave (#1051) and — unlike the shell's leave — is allowed
   * to refuse. `FilesAppLayout`'s handler is dirty-aware and opens a discard
   * dialog for an unsaved editor; the shell's leave is not, so the two must not
   * both be reachable.
   */
  shellMayPage: boolean;
  /** The shell root the native touch listeners bind to. */
  rootRef: RefObject<HTMLElement | null>;
}

export interface UseSwipePagerResult {
  /** Live preview offset, including the settle animation toward rest. */
  dragOffset: number;
  phase: SwipePhase;
  /** The frozen destination while the shell owns the contact. */
  destinationIndex: number | null;
  direction: -1 | 0 | 1;
  /** Why the last contact ended; observed by device diagnostics and E2E. */
  lastReason: string | null;
  isDragging: boolean;
}

function reportStandDown(reason: string, snapshot: SwipeSnapshot): void {
  // One line per abandoned contact, at the default console level, so a
  // physical-device report can tell a native OS Back swipe from a threshold
  // miss. A commit/snapback is reported by the settle half.
  console.info('[app-swipe]', reason, {
    phase: snapshot.phase,
    offset: snapshot.offset,
    destination: snapshot.destinationIndex,
  });
}

/**
 * The App's top-level pager (#1049, #1081, #2724).
 *
 * The state machine lives in `swipeGesture.ts`, the DOM binding in
 * `swipeTouchBinding.ts`, and the release animation in `useSwipeSettle.ts`.
 * This hook owns only the React state that joins them: the engine instance,
 * its latest snapshot, and the cancellation triggers that are not touch events
 * (another surface claiming the finger, the route or leave authority changing,
 * the page hiding).
 */
export function useSwipePager({
  pageCount,
  index,
  onIndexChange,
  getShellBounds,
  shellMayPage,
  rootRef,
}: UseSwipePagerArgs): UseSwipePagerResult {
  const optionsRef = useRef({ pageCount, index, onIndexChange, getShellBounds, shellMayPage });
  optionsRef.current = { pageCount, index, onIndexChange, getShellBounds, shellMayPage };

  const engineRef = useRef<SwipeGesture | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new SwipeGesture({
      getShellBounds: () => optionsRef.current.getShellBounds(),
      getIndex: () => optionsRef.current.index,
      getPageCount: () => optionsRef.current.pageCount,
      shellMayPage: () => optionsRef.current.shellMayPage,
    });
  }
  const engine = engineRef.current;

  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [snapshot, setSnapshot] = useState<SwipeSnapshot>(() => engine.snapshot());
  const publish = useCallback(() => {
    setSnapshot(engine.snapshot());
  }, [engine]);

  const { settle, complete, clearSettle } = useSwipeSettle({
    publish,
    onIndexChange,
    getShellBounds,
    reducedMotion,
  });
  const settleRef = useRef<SwipeSettleState | null>(settle);
  settleRef.current = settle;

  const standDown = useCallback(
    (reason: string) => {
      const wasTracking = engine.trackedIdentifier() !== null;
      clearSettle();
      const next = engine.cancel(reason);
      setSnapshot(next);
      if (wasTracking) {
        reportStandDown(reason, next);
      }
    },
    [clearSettle, engine],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    return bindSwipeTouchListeners(root, {
      engine,
      publish,
      standDown,
      complete,
      isSettling: () => settleRef.current !== null,
    });
  }, [complete, engine, publish, rootRef, standDown]);

  // A claim by another surface (today: the Terminal's long-press direction
  // pad, #2657) is authority, not an ordering accident. The claim may consume
  // the following events before they reach this root, so stand down from the
  // registry notification rather than waiting for a move that never arrives.
  useEffect(
    () => subscribeTouchOwnership((identifier, owner) => {
      if (engine.isTracking(identifier)) {
        standDown('owned-by:' + owner);
      }
    }),
    [engine, standDown],
  );

  // Losing the shell's authority or the route behind a live contact must not
  // leave a preview following a finger that no longer owns a destination.
  useEffect(() => {
    if (!shellMayPage && engine.trackedIdentifier() !== null) {
      standDown('shell-standdown');
    }
  }, [engine, shellMayPage, standDown]);

  useEffect(() => {
    if (engine.trackedIdentifier() !== null) {
      standDown('route-change');
    }
  }, [engine, index, pageCount, standDown]);

  useEffect(
    () => () => {
      engine.cancel('unmount');
    },
    [engine],
  );

  const phase: SwipePhase = settle !== null ? 'settling' : snapshot.phase;
  const dragOffset = settle?.offset ?? snapshot.offset;
  const destinationIndex = settle?.previewIndex ?? snapshot.destinationIndex;

  return {
    dragOffset,
    phase,
    destinationIndex,
    direction: snapshot.direction,
    lastReason: snapshot.reason,
    isDragging: phase === 'navigation' || phase === 'resisting' || phase === 'settling',
  };
}
