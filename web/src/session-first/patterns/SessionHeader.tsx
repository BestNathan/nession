import { ChevronLeft, Menu } from 'lucide-react';
import { AgentContext } from '@/session-first/patterns/AgentContext';
import { ConnectionStatus as SessionConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import {
  SurfaceSwitcher,
  type Surface,
} from '@/session-first/patterns/SurfaceSwitcher';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CapsuleExperience } from '@/session-first/capsule/types';
import type { DomainState } from '@/session-first/domainState';
import type { ConnectionStatus } from '@/types';

export type { Surface };

export interface SessionHeaderProps {
  sessionName: string;
  agentLabel: string;
  state: DomainState;
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
  onOpenAgent: () => void;
  onBackToSessions?: () => void;
  onOpenDrawer?: () => void;
  serverStatus?: ConnectionStatus;
  /** App experience: no Terminal|Workspace switcher — the spatial model owns navigation. */
  experience?: CapsuleExperience;
}

export function SessionHeader({
  sessionName,
  agentLabel,
  state,
  surface,
  onSurfaceChange,
  onOpenAgent,
  onBackToSessions,
  onOpenDrawer,
  serverStatus,
  experience = 'web',
}: SessionHeaderProps) {
  return (
    <header
      data-testid="session-header-line"
      className="flex shrink-0 flex-col gap-1 px-[var(--sf-space-4)] py-[var(--sf-space-2)] max-lg:gap-1.5 max-lg:px-[var(--sf-space-3)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        {onOpenDrawer ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]"
            aria-label="Open sessions"
            data-testid="session-first-open-drawer"
            onClick={() => onOpenDrawer()}
          >
            <Menu className="size-5" />
          </Button>
        ) : null}
        {onBackToSessions ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)] lg:hidden"
            aria-label="Back to sessions"
            data-testid="session-first-back-to-list"
            onClick={() => onBackToSessions()}
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        <h1 className="min-w-0 truncate font-mono text-base font-semibold">
          {sessionName}
        </h1>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
          <AgentContext agentLabel={agentLabel} state={state} onOpenAgent={onOpenAgent} />
          <SessionConnectionStatus state={state} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {serverStatus ? (
            <span
              data-testid="server-connection"
              className={cn(
                'font-mono text-xs',
                serverStatus === 'disconnected' ? 'text-agent-error' : 'text-muted-foreground',
              )}
            >
              server: {serverStatus}
            </span>
          ) : null}
          {experience !== 'app' ? (
            <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
          ) : null}
        </div>
      </div>
    </header>
  );
}
