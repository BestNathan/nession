import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentDisplayName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/features/files';
import type { DomainState } from '@/session-first/domainState';
import { SessionHeader, type Surface } from '@/session-first/patterns/SessionHeader';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { TerminalWell } from '@/session-first/TerminalWell';
import { shellIconButtonClass } from '@/session-first/shellStyles';
import { AppToolHeader } from '@/session-first/patterns/AppToolHeader';
import type {
  Experience,
  WorkspaceToolId,
} from '@/session-first/workspace/toolTypes';
import { WORKSPACE_TOOLS } from '@/session-first/workspace/tools';
import { WorkspaceShell } from '@/session-first/workspace/WorkspaceShell';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/services/socket';

interface WorkspaceTabPanelProps {
  selectedSession: Session;
  selectedAgent: Agent | undefined;
  agents: Agent[];
  domain: DomainState;
  surface: Surface;
  tool: WorkspaceToolId;
  fileOps: FileOps | null;
  experience: Experience;
  onSurfaceChange: (surface: Surface) => void;
  onToolChange: (tool: WorkspaceToolId) => void;
}

function WorkspaceTabPanel({
  selectedSession,
  selectedAgent,
  agents,
  domain,
  surface,
  tool,
  fileOps,
  experience,
  onSurfaceChange,
  onToolChange,
}: WorkspaceTabPanelProps) {
  return (
    <div
      role="tabpanel"
      id="workspace-tool-panel"
      aria-labelledby={`workspace-tool-tab-${tool}`}
      className={cn('flex min-h-0 flex-1 flex-col', surface !== 'workspace' && 'hidden')}
    >
      {experience === 'app' ? (
        <AppToolHeader
          toolLabel={WORKSPACE_TOOLS.find((t) => t.id === tool)!.label}
          onBack={() => onSurfaceChange('terminal')}
        />
      ) : null}
      <WorkspaceShell
        ctx={{
          session: selectedSession,
          agent: selectedAgent,
          agents,
          domain,
          fileOps,
          experience,
          onToolChange,
        }}
        activeTool={tool}
      />
    </div>
  );
}

export interface SessionFirstMainProps {
  selectedSession: Session | null;
  selectedAgent: Agent | undefined;
  agents: Agent[];
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
  connectionStatus: ConnectionState;
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
  agents,
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
            {showWorkspace && hasSession ? (
              <WorkspaceTabPanel
                selectedSession={selectedSession}
                selectedAgent={selectedAgent}
                agents={agents}
                domain={domain}
                surface={surface}
                tool={tool}
                fileOps={fileOps}
                experience={experience}
                onSurfaceChange={onSurfaceChange}
                onToolChange={onToolChange}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
