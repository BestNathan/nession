import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentDisplayName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DomainState } from '@/features/sessions/model/domainState';
import { SessionHeader, type Surface } from '@/app/patterns/SessionHeader';
import { shellIconButtonClass } from '@/app/shellStyles';
import type { Experience } from '@/app/workspace/toolTypes';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/services/socket';

export interface SessionMainHeaderProps {
  session: Session | null;
  agent: Agent | undefined;
  domain: DomainState | null;
  surface: Surface;
  connectionStatus: ConnectionState;
  experience: Experience;
  onSurfaceChange: (surface: Surface) => void;
  onOpenAgent: () => void;
  onBackToSessions?: () => void;
  onOpenDrawer?: () => void;
  onOpenWorkspace?: () => void;
}

/**
 * Session chrome above the work area: the live session header, or the resting
 * header when nothing is selected.
 */
export function SessionMainHeader({
  session,
  agent,
  domain,
  surface,
  connectionStatus,
  experience,
  onSurfaceChange,
  onOpenAgent,
  onBackToSessions,
  onOpenDrawer,
  onOpenWorkspace,
}: SessionMainHeaderProps) {
  const hasSession = session !== null && domain !== null;

  return hasSession ? (
    <SessionHeader
      sessionName={session.session_name}
      agentLabel={
        agent ? agentDisplayName(agent) : session.agent_id
      }
      state={domain}
      surface={surface}
      onSurfaceChange={onSurfaceChange}
      onOpenAgent={onOpenAgent}
      onBackToSessions={onBackToSessions}
      onOpenDrawer={onOpenDrawer}
      onOpenWorkspace={onOpenWorkspace}
      serverStatus={connectionStatus}
      experience={experience}
    />
  ) : (
    <div
      data-testid="session-resting-header"
      className="flex shrink-0 items-center justify-between px-[var(--shell-space-4)] py-[var(--shell-space-2)]"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={shellIconButtonClass}
        aria-label="Open sessions"
        data-testid="session-first-open-drawer"
        onClick={() => onOpenDrawer?.()}
      >
        <Menu className="size-5" />
      </Button>
      {connectionStatus ? (
        <span
          data-testid="server-connection"
          className={cn(
            'font-mono text-xs',
            connectionStatus === 'disconnected'
              ? 'text-agent-error'
              : 'text-muted-foreground',
          )}
        >
          server: {connectionStatus}
        </span>
      ) : null}
    </div>
  );
}
