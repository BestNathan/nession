import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CapabilityId } from '@/product/capability';
import type {
  WorkspaceDepthControl,
  WorkspaceForward,
  WorkspaceHeaderAction,
  WorkspacePush,
} from '../workspaceContext';

/** Which capability registered the push on screen. */
interface PushedDepth {
  capabilityId: CapabilityId;
  push: WorkspacePush;
}

/** Which capability registered the page-header actions. */
interface HeaderActions {
  capabilityId: CapabilityId;
  actions: readonly WorkspaceHeaderAction[];
}

/** Which capability recorded the forward destination. */
interface ForwardDestination {
  capabilityId: CapabilityId;
  forward: WorkspaceForward;
}

/**
 * The App page-header state a Workspace capability contributes.
 *
 * All three halves are **capability-stamped**: a view that has already been
 * switched away cannot keep another capability's pager fenced off (#2780),
 * decorate the new capability's header, or offer a forward gesture into a
 * resource the new capability does not own. A layout effect advances the stamp
 * before the newly mounted view's passive effects can publish, while render
 * stays pure.
 *
 * The hook exists so `WorkspacePanel` composes the header rather than owning
 * several nearly identical state machines, and so the retirement rule has one
 * owner for the depth, the contextual actions and the forward history alike.
 */
export function useWorkspaceCapabilityChrome(tool: CapabilityId) {
  const [pushed, setPushed] = useState<PushedDepth | null>(null);
  const [headerActions, setHeaderActions] = useState<HeaderActions | null>(null);
  const [forwardDestination, setForwardDestination] = useState<ForwardDestination | null>(null);

  const activeToolRef = useRef(tool);
  useLayoutEffect(() => {
    activeToolRef.current = tool;
  }, [tool]);

  // The depth on screen is already capability-scoped for display; the pager
  // must read the same fact. Exporting `pushed !== null` let a push owned by a
  // capability the user already left keep the new root fenced off (#2780).
  const push = pushed && pushed.capabilityId === tool ? pushed.push : null;
  const actions =
    headerActions && headerActions.capabilityId === tool ? headerActions.actions : null;
  const forward =
    forwardDestination && forwardDestination.capabilityId === tool
      ? forwardDestination.forward
      : null;

  // Switching capabilities unmounts the view that pushed, contributed actions
  // or recorded a forward destination, so all three belong to a view the user
  // has left. Retire instead of restoring them when the capability is selected
  // again: the remounted view starts at its own root and declares its own
  // chrome. Runs after the new view's passive effects, so a fresh registration
  // is not cleared.
  useEffect(() => {
    setPushed((current) =>
      current !== null && current.capabilityId !== tool ? null : current,
    );
    setHeaderActions((current) =>
      current !== null && current.capabilityId !== tool ? null : current,
    );
    setForwardDestination((current) =>
      current !== null && current.capabilityId !== tool ? null : current,
    );
  }, [tool]);

  const setPush = useCallback(
    (nextPush: WorkspacePush | null) => {
      // A callback from a capability the user has already switched away from
      // cannot publish a depth for the capability now on screen.
      if (activeToolRef.current !== tool) {
        return;
      }
      setPushed(nextPush === null ? null : { capabilityId: tool, push: nextPush });
    },
    [tool],
  );

  const setActions = useCallback(
    (nextActions: readonly WorkspaceHeaderAction[] | null) => {
      // The same ownership rule as `setPush`: the actions belong to the
      // capability that contributed them, not to whichever view renders next.
      if (activeToolRef.current !== tool) {
        return;
      }
      setHeaderActions(
        nextActions === null || nextActions.length === 0
          ? null
          : { capabilityId: tool, actions: nextActions },
      );
    },
    [tool],
  );

  const setForward = useCallback(
    (nextForward: WorkspaceForward | null) => {
      // A forward destination is a navigation capability, so it obeys the same
      // ownership rule as the depth that produced it.
      if (activeToolRef.current !== tool) {
        return;
      }
      setForwardDestination(
        nextForward === null ? null : { capabilityId: tool, forward: nextForward },
      );
    },
    [tool],
  );

  const depth: WorkspaceDepthControl = useMemo(
    () => ({ setPush, setActions, setForward }),
    [setActions, setForward, setPush],
  );

  return { push, actions, forward, depth };
}
