import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import type { WorkspaceStackReport } from '@/app/workspace/workspaceContext';
import { useSwipePagerCancellations } from './useSwipePagerCancellations';
import type { ShellBounds } from './edgeBand';
import {
  SwipeGesture,
  type InnerSwipeAction,
  type SwipePhase,
  type SwipeSnapshot,
} from './swipeGesture';
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
  /**
   * The active Workspace depth's inner stack (#3971), or null when it has
   * none. The same coordinator routes a claimed contact here before the outer
   * spatial pager; there is never a second touch owner.
   */
  innerStack?: WorkspaceStackReport | null;
  /** The shell root the native touch listeners bind to. */
  rootRef: RefObject<HTMLElement | null>;
}

export interface UseSwipePagerResult {
  /** Live preview offset, including the settle animation toward rest. */
  dragOffset: number;
  phase: SwipePhase;
  /** The frozen destination while the shell owns the contact. */
  destinationIndex: number | null;
  /** The inner stack operation the contact resolved to, if any. */
  innerAction: InnerSwipeAction | null;
  /** The inner page's live offset while the Workspace stack moves. */
  innerOffset: number;
  /** True while an inner destination settles back to rest. */
  innerSettling: boolean;
  /** The destination title, for the transient preview label. */
  destinationLabel: string | null;
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
 * The public shape from the latest snapshot and settle state.
 *
 * An inner stack move and an outer page are mutually exclusive for one
 * contact. Keeping their offsets separate is what stops an inner Pop from
 * translating the whole Workspace layer over the Terminal.
 */
function pagerResult(
  settle: SwipeSettleState | null,
  snapshot: SwipeSnapshot,
): UseSwipePagerResult {
  const phase: SwipePhase = settle !== null ? 'settling' : snapshot.phase;
  const innerAction = settle?.innerAction ?? snapshot.innerAction;
  const innerSettling = settle !== null && settle.innerAction !== null;
  const innerOffset = innerAction === null ? 0 : (settle?.offset ?? snapshot.offset);
  const destinationLabel = innerAction === null
    ? null
    : (settle?.destinationLabel ?? snapshot.destinationLabel);
  const dragOffset = innerAction === null ? (settle?.offset ?? snapshot.offset) : 0;
  const destinationIndex = innerAction === null
    ? (settle?.previewIndex ?? snapshot.destinationIndex)
    : null;
  return {
    dragOffset,
    phase,
    destinationIndex,
    innerAction,
    innerOffset,
    innerSettling,
    destinationLabel,
    direction: snapshot.direction,
    lastReason: snapshot.reason,
    isDragging: phase === 'navigation' || phase === 'resisting' || phase === 'settling',
  };
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
  innerStack = null,
  rootRef,
}: UseSwipePagerArgs): UseSwipePagerResult {
  const optionsRef = useRef({
    pageCount,
    index,
    onIndexChange,
    getShellBounds,
    shellMayPage,
    innerStack,
  });
  optionsRef.current = {
    pageCount,
    index,
    onIndexChange,
    getShellBounds,
    shellMayPage,
    innerStack,
  };

  const engineRef = useRef<SwipeGesture | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new SwipeGesture({
      getShellBounds: () => optionsRef.current.getShellBounds(),
      getIndex: () => optionsRef.current.index,
      getPageCount: () => optionsRef.current.pageCount,
      shellMayPage: () => optionsRef.current.shellMayPage,
      getInnerStack: () => {
        const stack = optionsRef.current.innerStack;
        if (stack === null) {
          return null;
        }
        return {
          pop: stack.pop?.title ?? null,
          forward: stack.forward?.title ?? null,
        };
      },
    });
  }
  const engine = engineRef.current;

  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [snapshot, setSnapshot] = useState<SwipeSnapshot>(() => engine.snapshot());
  const publish = useCallback(() => {
    setSnapshot(engine.snapshot());
  }, [engine]);

  const onInnerCommit = useCallback((action: InnerSwipeAction) => {
    const stack = optionsRef.current.innerStack;
    if (stack === null) {
      return;
    }
    const destination = action === 'pop' ? stack.pop : stack.forward;
    destination?.onActivate();
  }, []);

  const { settle, complete, clearSettle } = useSwipeSettle({
    publish,
    onIndexChange,
    onInnerCommit,
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

  useSwipePagerCancellations({
    engine,
    shellMayPage,
    innerStack,
    index,
    pageCount,
    standDown,
  });

  useEffect(
    () => () => {
      engine.cancel('unmount');
    },
    [engine],
  );

  return pagerResult(settle, snapshot);
}
