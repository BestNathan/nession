import { useEffect, useMemo, useRef } from 'react';
import type { Agent, Session } from '@/types';
import type {
  WorkspaceForward,
  WorkspacePush,
  WorkspaceStackReport,
} from '../workspaceContext';

/** The trusted Session/Agent line at a capability root, or `null`. */
export function sessionContextLabel(
  session: Session | null | undefined,
  agent: Agent | undefined,
): string | undefined {
  const sessionName = session?.session_name?.trim();
  const agentLabel = agent?.display_name?.trim() || agent?.hostname?.trim();
  if (sessionName && agentLabel) {
    return `${sessionName} · ${agentLabel}`;
  }
  return sessionName || agentLabel || undefined;
}

/**
 * The header's secondary line (#3971).
 *
 * At a pushed depth it is the real immediate ancestry the capability reported;
 * at a capability root it is the active Session/Agent context when the shell can
 * trust it. It never manufactures a breadcrumb.
 */
export function workspaceSubtitle(
  push: WorkspacePush | null,
  activeLabel: string,
  sessionContext: string | undefined,
): string | undefined {
  if (push === null) {
    return sessionContext;
  }
  return push.subtitle ?? push.ancestors?.[0]?.title ?? activeLabel;
}

/** What Back names; the capability's own label wins when it supplied one. */
export function workspaceBackLabel(
  push: WorkspacePush | null,
  activeLabel: string,
  hasSession: boolean,
): string {
  if (push !== null) {
    return push.backLabel
      ?? (push.ancestors?.[0] ? `Back to ${push.ancestors[0].title}` : `Back to ${activeLabel}`);
  }
  return hasSession ? 'Back to terminal' : 'Back to sessions';
}

/**
 * Report the inner stack destinations a claimed App contact may operate.
 *
 * Pop is the capability's own guarded leave, so a dirty editor refuses the
 * swipe exactly as it refuses Back. Forward exists only when the capability
 * recorded one. The unmount reset goes through a ref so a callback identity
 * change does not clear and re-set the pager's stack between renders.
 */
export function useWorkspaceStackReport({
  push,
  forward,
  activeLabel,
  onStackChange,
}: {
  push: WorkspacePush | null;
  forward: WorkspaceForward | null;
  activeLabel: string;
  onStackChange: ((stack: WorkspaceStackReport | null) => void) | undefined;
}): void {
  const stackReport = useMemo<WorkspaceStackReport>(
    () => ({
      pop: push
        ? { title: push.ancestors?.[0]?.title ?? activeLabel, onActivate: push.onLeave }
        : null,
      forward: forward ?? null,
    }),
    [activeLabel, forward, push],
  );

  const onStackChangeRef = useRef(onStackChange);
  onStackChangeRef.current = onStackChange;
  useEffect(() => {
    onStackChangeRef.current?.(stackReport);
  }, [stackReport]);
  useEffect(
    () => () => {
      onStackChangeRef.current?.(null);
    },
    [],
  );
}
