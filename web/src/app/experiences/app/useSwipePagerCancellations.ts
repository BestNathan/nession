import { useEffect, useRef } from 'react';
import { subscribeTouchOwnership } from '@/shared/lib/touchOwnership';
import type { WorkspaceStackReport } from '@/app/workspace/workspaceContext';
import type { SwipeGesture } from './swipeGesture';

/**
 * The cancellation triggers of the App pager that are not touch events
 * (#2724, #3971).
 *
 * A claimed contact must lose its preview when the authority behind it changes:
 * another surface claims the finger, the shell's leave authority disappears, the
 * route changes, or the capability's inner stack is replaced under the finger.
 * Each is an event the touch binding may never see, so it is observed here
 * rather than inferred from a move that never arrives.
 */
export function useSwipePagerCancellations({
  engine,
  shellMayPage,
  innerStack,
  index,
  pageCount,
  standDown,
  isSettledRouteChange = () => false,
  clearSettledRouteChange = () => {},
}: {
  engine: SwipeGesture;
  shellMayPage: boolean;
  innerStack: WorkspaceStackReport | null;
  index: number;
  pageCount: number;
  standDown: (reason: string) => void;
  /**
   * Whether the authority currently changing is the commit a newly arrived
   * contact just caught up, rather than authority moving under the contact.
   */
  isSettledRouteChange?: () => boolean;
  /** Clear that expectation after the change has been observed. */
  clearSettledRouteChange?: () => void;
}): void {
  useEffect(
    () => subscribeTouchOwnership((identifier, owner) => {
      if (engine.isTracking(identifier)) {
        standDown('owned-by:' + owner);
      }
    }),
    [engine, standDown],
  );

  // Losing the shell's authority must not leave a preview following a finger
  // that no longer owns a destination.
  useEffect(() => {
    if (!shellMayPage && engine.trackedIdentifier() !== null) {
      standDown('shell-standdown');
    }
  }, [engine, shellMayPage, standDown]);

  const previousIndexRef = useRef(index);
  useEffect(() => {
    if (previousIndexRef.current === index) {
      return;
    }
    previousIndexRef.current = index;
    // A settle caught up by the contact's own start owns the route change it
    // commits; standing down here would kill the gesture the user just began.
    if (isSettledRouteChange()) {
      return;
    }
    if (engine.trackedIdentifier() !== null) {
      standDown('route-change');
    }
  }, [engine, index, isSettledRouteChange, standDown]);

  const previousPageCountRef = useRef(pageCount);
  useEffect(() => {
    if (previousPageCountRef.current === pageCount) {
      return;
    }
    previousPageCountRef.current = pageCount;
    if (engine.trackedIdentifier() !== null) {
      standDown('route-change');
    }
  }, [engine, pageCount, standDown]);

  // The capability's inner stack is authority too: a depth that changed while
  // a contact was live must not commit the destination the finger froze. A
  // catch-up commit may itself unmount the previous capability's stack, which
  // is the expected consequence of the contact that just started (#4185).
  useEffect(() => {
    if (engine.trackedIdentifier() !== null && !isSettledRouteChange()) {
      standDown('stack-change');
    }
  }, [engine, innerStack, isSettledRouteChange, standDown]);

  // This effect runs after every render, therefore after the change-observing
  // effects above in the same commit, and clears the one-commit expectation.
  useEffect(() => {
    clearSettledRouteChange();
  });
}
