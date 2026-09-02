import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentDisplayName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/services/fileOps';
import type { DomainState } from '@/session-first/domainState';
import { SessionHeader, type Surface } from '@/session-first/patterns/SessionHeader';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { TerminalWell } from '@/session-first/TerminalWell';
import type {
  Experience,
  WorkspaceToolId,
} from '@/session-first/workspace/toolTypes';
import { WorkspaceShell } from '@/session-first/workspace/WorkspaceShell';
import type { Agent, ConnectionStatus, Session } from '@/types';

export interface SessionFirstMainProps {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  domain: DomainState | null;
  surface: Surface;
  tool: WorkspaceToolId;
  fileOps: FileOps | null;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: WorkspaceToolId) => void;
  onOpenAgent: () => void;
  onBackToSessions?: () => void;
  onOpenDrawer?: () => void;
  onOpenWorkspace?: () => void;
  connectionStatus: ConnectionStatus;
  /** Spatial shell: omit terminal on the Workspace page to avoid a second xterm. */
  showTerminal?: boolean;
  /** Spatial shell: omit workspace panel on the Terminal page. */
  showWorkspace?: boolean;
  /** Fixture/testing override for the terminal surface. Defaults to the real attached terminal. */
  terminal?: ReactNode;
  /** App experience: the SessionHeader renders no Terminal|Workspace switcher. */
  experience?: Experience;
}

export function SessionFirstMain({
  selectedSession,
  selectedAgent,
  domain,
  surface,
  tool,
  fileOps,
  onSurfaceChange,
  onToolChange,
  onOpenAgent,
  onBackToSessions,
  onOpenDrawer,
  onOpenWorkspace,
  connectionStatus,
  showTerminal = true,
  showWorkspace = true,
  terminal,
  experience = 'web',
}: SessionFirstMainProps) {
  const hasSession = selectedSession !== null && domain !== null;
  return (
    <>
      {hasSession ? (
        <SessionHeader
          sessionName={selectedSession.session_name}
          agentLabel={
            selectedAgent ? agentDisplayName(selectedAgent) : selectedSession.agent_id
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
          className="flex shrink-0 items-center justify-between px-[var(--sf-space-4)] py-[var(--sf-space-2)]"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
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
      )}
      <div
        data-testid="session-first-main-content"
        className="relative flex min-h-0 flex-1 flex-col gap-0">
        {!hasSession ? (
          <div
            data-testid="session-empty-state"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <p>Select a session to start working</p>
          </div>
        ) : (
          <>
            {showTerminal ? (
              <TerminalWell
                className={cn('min-h-0', (surface !== 'terminal' || !selectedSession) && 'hidden')}
              >
                {terminal ?? (
                  <SessionFirstTerminal
                    hidden={surface !== 'terminal' || !selectedSession}
                    onDisconnect={() => undefined}
                    onError={() => undefined}
                  />
                )}
              </TerminalWell>
            ) : null}
            {showWorkspace ? (
              <div
                role="tabpanel"
                id="workspace-tool-panel"
                aria-labelledby={`workspace-tool-tab-${tool}`}
                className={cn('min-h-0 flex-1', surface !== 'workspace' && 'hidden')}
              >
                <WorkspaceShell
                  ctx={{
                    session: selectedSession,
                    agent: selectedAgent,
                    domain,
                    fileOps,
                    experience,
                    onToolChange,
                  }}
                  activeTool={tool}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
