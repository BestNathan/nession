import { agentDisplayName } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/services/fileOps';
import type { DomainState } from '@/session-first/domainState';
import { AgentDetail } from '@/session-first/patterns/AgentDetail';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';
import { SessionHeader, type Surface } from '@/session-first/patterns/SessionHeader';
import {
  WorkspaceNavigation,
  type WorkspaceToolId,
} from '@/session-first/patterns/WorkspaceNavigation';
import { SessionDetails } from '@/session-first/SessionDetails';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import { TerminalWell } from '@/session-first/TerminalWell';
import type { Agent, Session } from '@/types';

function WorkspacePanel({
  hidden,
  tool,
  onToolChange,
  fileOps,
  session,
  agent,
  domain,
}: {
  hidden: boolean;
  tool: WorkspaceToolId;
  onToolChange: (tool: WorkspaceToolId) => void;
  fileOps: FileOps | null;
  session: Session | null;
  agent: Agent | undefined;
  domain: DomainState | null;
}) {
  return (
    <div className={cn('absolute inset-0 flex min-h-0 flex-col', hidden && 'hidden')}>
      <WorkspaceNavigation tool={tool} onToolChange={onToolChange} filesAvailable />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tool === 'files' && <FileWorkspace fileOps={fileOps} />}
        {tool === 'session' && session && domain && (
          <SessionDetails session={session} state={domain} />
        )}
        {tool === 'agent' && agent && domain && (
          <AgentDetail agent={agent} state={domain} />
        )}
      </div>
    </div>
  );
}

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
  /** Spatial shell: omit terminal on the Workspace page to avoid a second xterm. */
  showTerminal?: boolean;
  /** Spatial shell: omit workspace panel on the Terminal page. */
  showWorkspace?: boolean;
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
  showTerminal = true,
  showWorkspace = true,
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
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col gap-0 p-3 pt-2">
        {showTerminal ? (
          <TerminalWell
            className={cn(
              'min-h-0',
              (surface !== 'terminal' || !selectedSession) && 'hidden',
            )}
          >
            <SessionFirstTerminal
              hidden={surface !== 'terminal' || !selectedSession}
              onDisconnect={() => undefined}
              onError={() => undefined}
            />
          </TerminalWell>
        ) : null}
        {showWorkspace ? (
          <WorkspacePanel
            hidden={surface !== 'workspace'}
            tool={tool}
            onToolChange={onToolChange}
            fileOps={fileOps}
            session={selectedSession}
            agent={selectedAgent}
            domain={domain}
          />
        ) : null}
      </div>
    </>
  );
}
