import { ChevronLeft, Menu, PanelRight } from 'lucide-react';
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
  onOpenWorkspace?: () => void;
  serverStatus?: ConnectionStatus;
  /** App experience: no Terminal|Workspace switcher — the spatial model owns navigation. */
  experience?: CapsuleExperience;
}

interface MenuButtonOptions {
  label: string;
  testid: string;
  onClick: () => void;
  className: string;
}

/**
 * Shared ghost menu button for both header branches. Only the size differs
 * (app: 44px touch target, web: 36px) — everything else must not drift.
 */
function renderMenuButton({ label, testid, onClick, className }: MenuButtonOptions) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      data-testid={testid}
      onClick={() => onClick()}
    >
      <Menu className="size-5" />
    </Button>
  );
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
  onOpenWorkspace,
  serverStatus,
  experience = 'web',
}: SessionHeaderProps) {
  const title = (
    <h1 className="min-w-0 truncate font-mono text-base font-semibold">{sessionName}</h1>
  );
  if (experience === 'app') {
    return (
      <header
        data-testid="session-header-line"
        className="flex shrink-0 items-center gap-2 px-[var(--shell-space-3)] pt-[max(var(--shell-space-2),env(safe-area-inset-top))]"
      >
        {onOpenDrawer
          ? renderMenuButton({
              label: 'Sessions',
              testid: 'app-header-sessions',
              onClick: onOpenDrawer,
              className:
                'size-11 shrink-0 transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
            })
          : null}
        {title}
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
          <SessionConnectionStatus state={state} />
        </div>
        {onOpenWorkspace ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]"
            aria-label="Workspace"
            data-testid="app-header-workspace"
            onClick={() => onOpenWorkspace()}
          >
            <PanelRight className="size-5" />
          </Button>
        ) : null}
      </header>
    );
  }
  return (
    <header
      data-testid="session-header-line"
      className="flex shrink-0 flex-col gap-1 px-[var(--shell-space-4)] py-[var(--shell-space-2)] max-lg:gap-1.5 max-lg:px-[var(--shell-space-3)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        {onOpenDrawer
          ? renderMenuButton({
              label: 'Open sessions',
              testid: 'session-first-open-drawer',
              onClick: onOpenDrawer,
              className:
                'size-9 shrink-0 transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
            })
          : null}
        {onBackToSessions ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)] lg:hidden"
            aria-label="Back to sessions"
            data-testid="session-first-back-to-list"
            onClick={() => onBackToSessions()}
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        {title}
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
          <SurfaceSwitcher surface={surface} onSurfaceChange={onSurfaceChange} />
        </div>
      </div>
    </header>
  );
}
