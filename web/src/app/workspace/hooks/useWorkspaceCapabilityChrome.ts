import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CapabilityId } from '@/product/capability';
import type {
  WorkspaceDepthControl,
  WorkspaceHeaderAction,
  WorkspacePush,
} from '../workspaceContext';

/** Which capability registered the push on screen. */
interface PushedDepth {
  capabilityId: CapabilityId;
  push: WorkspacePush;
}

/** Which capability registered the page-header action. */
interface HeaderAction {
  capabilityId: CapabilityId;
  action: WorkspaceHeaderAction;
}

/**
 * The App page-header state a Workspace capability contributes.
 *
 * Both halves are **capability-stamped**: a view that has already been switched
 * away cannot keep another capability's pager fenced off (#2780) or decorate
 * the new capability's header. A layout effect advances the stamp before the
 * newly mounted view's passive effects can publish, while render stays pure.
 *
 * The hook exists so `WorkspacePanel` composes the header rather than owning
 * two nearly identical state machines, and so the retirement rule has one
 * owner for the depth and the contextual action alike.
 */
export function useWorkspaceCapabilityChrome(tool: CapabilityId) {
  const [pushed, setPushed] = useState<PushedDepth | null>(null);
  const [headerAction, setHeaderAction] = useState<HeaderAction | null>(null);

  const activeToolRef = useRef(tool);
  useLayoutEffect(() => {
    activeToolRef.current = tool;
  }, [tool]);

  // The depth on screen is already capability-scoped for display; the pager
  // must read the same fact. Exporting `pushed !== null` let a push owned by a
  // capability the user already left keep the new root fenced off (#2780).
  const push = pushed && pushed.capabilityId === tool ? pushed.push : null;
  const action =
    headerAction && headerAction.capabilityId === tool ? headerAction.action : null;

  // Switching capabilities unmounts the view that pushed or contributed the
  // action, so both belong to a view the user has left. Retire instead of
  // restoring them when the capability is selected again: the remounted view
  // starts at its own root and declares its own action. Runs after the new
  // view's passive effects, so a fresh registration is not cleared.
  useEffect(() => {
    setPushed((current) =>
      current !== null && current.capabilityId !== tool ? null : current,
    );
    setHeaderAction((current) =>
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

  const setAction = useCallback(
    (nextAction: WorkspaceHeaderAction | null) => {
      // The same ownership rule as `setPush`: the action belongs to the
      // capability that contributed it, not to whichever view renders next.
      if (activeToolRef.current !== tool) {
        return;
      }
      setHeaderAction(
        nextAction === null ? null : { capabilityId: tool, action: nextAction },
      );
    },
    [tool],
  );

  const depth: WorkspaceDepthControl = useMemo(
    () => ({ setPush, setAction }),
    [setAction, setPush],
  );

  return { push, action, depth };
}
