import { useEffect } from 'react';
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
}: {
  engine: SwipeGesture;
  shellMayPage: boolean;
  innerStack: WorkspaceStackReport | null;
  index: number;
  pageCount: number;
  standDown: (reason: string) => void;
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

  useEffect(() => {
    if (engine.trackedIdentifier() !== null) {
      standDown('route-change');
    }
  }, [engine, index, pageCount, standDown]);

  // The capability's inner stack is authority too: a depth that changed while
  // a contact was live must not commit the destination the finger froze.
  useEffect(() => {
    if (engine.trackedIdentifier() !== null) {
      standDown('stack-change');
    }
  }, [engine, innerStack, standDown]);
}
