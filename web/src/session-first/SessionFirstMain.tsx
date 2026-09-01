import type { ReactNode } from 'react';
import { agentDisplayName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/services/fileOps';
import type { DomainState } from '@/session-first/domainState';
import { SessionHeader, type Surface } from '@/session-first/patterns/SessionHeader';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { TerminalWell } from '@/session-first/TerminalWell';
import type { WorkspaceToolId } from '@/session-first/workspace/toolTypes';
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
  serverStatus?: ConnectionStatus;
  /** Spatial shell: omit terminal on the Workspace page to avoid a second xterm. */
  showTerminal?: boolean;
  /** Spatial shell: omit workspace panel on the Terminal page. */
  showWorkspace?: boolean;
  /** Fixture/testing override for the terminal surface. Defaults to the real attached terminal. */
  terminal?: ReactNode;
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
  serverStatus,
  showTerminal = true,
  showWorkspace = true,
  terminal,
}: SessionFirstMainProps) {
  return (
    <>
      {selectedSession && domain ? (
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
          serverStatus={serverStatus}
        />
      ) : null}
      <div
        data-testid="session-first-main-content"
        className="relative flex min-h-0 flex-1 flex-col gap-0">
        {showTerminal ? (
          <TerminalWell
            className={cn(
              'min-h-0',
              (surface !== 'terminal' || !selectedSession) && 'hidden',
            )}
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
                experience: 'web',
                onToolChange,
              }}
              activeTool={tool}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
