import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/features/files';
import type { DomainState } from '@/features/sessions/model/domainState';
import { SessionFirstTerminal } from '@/app/SessionFirstTerminal';
import { TerminalWell } from '@/app/TerminalWell';
import type {
  Experience,
  WorkspaceToolId,
} from '@/app/workspace/toolTypes';
import type { Surface } from '@/app/patterns/SessionHeader';
import { SessionMainHeader } from '@/app/SessionMainHeader';
import { WorkspacePanel } from '@/app/WorkspacePanel';
import { useCapsuleCapability } from '@/app/useCapsuleCapability';
import type { Agent, Session } from '@/types';
import type { ConnectionState } from '@/services/socket';

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
  const { facts, presence: capsuleCapability } = useCapsuleCapability({
    session: selectedSession,
    agent: selectedAgent,
    agents,
    domain,
    fileOps,
    experience,
    onToolChange,
    onSurfaceChange: () => onSurfaceChange('workspace'),
  });

  return (
    <>
      <SessionMainHeader
        session={selectedSession}
        agent={selectedAgent}
        domain={domain}
        surface={surface}
        connectionStatus={connectionStatus}
        experience={experience}
        onSurfaceChange={onSurfaceChange}
        onOpenAgent={onOpenAgent}
        onBackToSessions={onBackToSessions}
        onOpenDrawer={onOpenDrawer}
        onOpenWorkspace={onOpenWorkspace}
      />
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
                    capsuleCapability={capsuleCapability}
                  />
                )}
              </TerminalWell>
            ) : null}
            {showWorkspace && hasSession ? (
              <WorkspacePanel
                selectedSession={selectedSession}
                selectedAgent={selectedAgent}
                agents={agents}
                domain={domain}
                surface={surface}
                tool={tool}
                fileOps={fileOps}
                experience={experience}
                facts={facts}
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
