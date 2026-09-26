import { SessionHeader } from '@/app/patterns/SessionHeader';
import { AppHomeHeader } from '@/app/experiences/app/AppHomeHeader';
import type { DomainState } from '@/product/session/model/domainState';
import type { Experience } from '@/app/workspace/workspaceContext';
import type { Session } from '@/types';

export interface SessionMainHeaderProps {
  session: Session | null;
  domain: DomainState | null;
  experience: Experience;
  onOpenDrawer?: () => void;
  onOpenWorkspace?: () => void;
}

/**
 * Session chrome above the work area — **App only**.
 *
 * Web renders nothing here (#748, SC1). Its duties moved rather than
 * disappearing: Session identity to the selected row in the sidebar, agent
 * reachability to that row's own metadata, service and attachment state to the
 * sidebar footer, and Workspace reach to the floating surface capsule.
 *
 * The resting header is gone with it. It existed to keep a Sessions affordance
 * and a server status on screen when no Session was selected; Web now always
 * has the sidebar, and App reaches Sessions through its own spatial model.
 */
export function SessionMainHeader({
  session,
  domain,
  experience,
  onOpenDrawer,
  onOpenWorkspace,
}: SessionMainHeaderProps) {
  if (experience !== 'app') {
    return null;
  }
  if (session === null || domain === null) {
    // The no-Session root is a home, not an absence (#1082). It keeps the one
    // piece of navigation the App has no second route to — Sessions — and
    // deliberately not a Session title, Workspace, or status: there is no
    // Session to describe, and faking its identity would be the dead end this
    // state used to be, wearing chrome.
    return <AppHomeHeader onOpenDrawer={onOpenDrawer} />;
  }
  return (
    <SessionHeader
      sessionName={session.session_name}
      state={domain}
      onOpenDrawer={onOpenDrawer}
      onOpenWorkspace={onOpenWorkspace}
      experience={experience}
    />
  );
}
