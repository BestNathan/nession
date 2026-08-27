import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useProbePolling } from '@/hooks/useProbePolling';
import { useSessionFirstAttach } from '@/hooks/useSessionFirstAttach';
import { p2pConnectionAtom } from '@/atoms/connection';
import { sessionIdAtom } from '@/atoms/session';
import { agentDisplayName } from '@/lib/format';
import { setSessionFirst } from '@/lib/sessionFirst';
import { cn } from '@/lib/utils';
import { createFileOps, type FileOps } from '@/services/fileOps';
import { mapDomainState, type DomainState } from '@/session-first/domainState';
import { AgentDetail } from '@/session-first/patterns/AgentDetail';
import { FileWorkspace } from '@/session-first/patterns/FileWorkspace';
import { SessionHeader, type Surface } from '@/session-first/patterns/SessionHeader';
import { SessionList } from '@/session-first/patterns/SessionList';
import {
  WorkspaceNavigation,
  type WorkspaceToolId,
} from '@/session-first/patterns/WorkspaceNavigation';
import { SessionDetails } from '@/session-first/SessionDetails';
import { SessionFirstTerminal } from '@/session-first/SessionFirstTerminal';
import type { Agent, Session } from '@/types';

export interface SessionFirstShellProps {
  onLegacy: () => void;
}

function LegacyToggle({ onLegacy }: { onLegacy: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="use-legacy-dashboard"
      onClick={() => {
        setSessionFirst(false);
        onLegacy();
      }}
    >
      Use legacy dashboard
    </Button>
  );
}

interface WorkspacePanelProps {
  hidden: boolean;
  tool: WorkspaceToolId;
  onToolChange: (tool: WorkspaceToolId) => void;
  fileOps: FileOps | null;
  session: Session | null;
  agent: Agent | undefined;
  domain: DomainState | null;
}

function WorkspacePanel({
  hidden, tool, onToolChange, fileOps, session, agent, domain,
}: WorkspacePanelProps) {
  return (
    <div className={cn('absolute inset-0 flex min-h-0 flex-col', hidden && 'hidden')}>
      <WorkspaceNavigation
        tool={tool}
        onToolChange={onToolChange}
        filesAvailable
      />
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

export function SessionFirstShell({ onLegacy }: SessionFirstShellProps) {
  const { agents, sessions, staleAgents } = useDashboard();
  useProbePolling(agents);
  const clientSessionId = useAtomValue(sessionIdAtom);
  const p2pConnection = useAtomValue(p2pConnectionAtom);
  const { attachInFlightId, attachFailedId, attach } = useSessionFirstAttach();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<WorkspaceToolId>('files');
  const selectedSession = selectedId
    ? sessions.find((session) => session.session_id === selectedId) ?? null
    : null;

  const sendMessage = p2pConnection?.sendMessage;
  const onMessage = p2pConnection?.onMessage;
  const waitForConnection = p2pConnection?.waitForConnection;
  const fileOps = useMemo(
    () =>
      sendMessage && onMessage && waitForConnection
        ? createFileOps({ sendMessage, onMessage, waitForConnection })
        : null,
    [sendMessage, onMessage, waitForConnection],
  );

  const selectedAgent = selectedSession
    ? agents.find((a) => a.agent_id === selectedSession.agent_id)
    : undefined;
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: staleAgents,
        clientSessionId,
        attachInFlightId,
        attachFailedId,
      })
    : null;

  return (
    <div className="flex h-[100dvh]">
      <aside className="flex h-full w-72 shrink-0 flex-col border-r">
        <SessionList
          sessions={sessions}
          agents={agents}
          staleAgentIds={staleAgents}
          selectedId={selectedId}
          clientSessionId={clientSessionId}
          attachInFlightId={attachInFlightId}
          attachFailedId={attachFailedId}
          onSelect={(s) => {
            setSelectedId(s.session_id);
            setSurface('terminal');
            setTool('files');
            void attach(s);
          }}
        />
      </aside>
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
          <LegacyToggle onLegacy={onLegacy} />
        </div>
        {selectedSession && domain ? (
          <SessionHeader
            sessionName={selectedSession.session_name}
            agentLabel={
              selectedAgent ? agentDisplayName(selectedAgent) : selectedSession.agent_id
            }
            state={domain}
            surface={surface}
            onSurfaceChange={(next) => setSurface(next)}
            onOpenAgent={() => {
              setSurface('workspace');
              setTool('agent');
            }}
          />
        ) : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SessionFirstTerminal
            hidden={surface !== 'terminal' || !selectedSession}
            onDisconnect={() => undefined}
            onError={() => undefined}
          />
          <WorkspacePanel
            hidden={surface !== 'workspace'}
            tool={tool}
            onToolChange={(next) => setTool(next)}
            fileOps={fileOps}
            session={selectedSession}
            agent={selectedAgent}
            domain={domain}
          />
        </div>
      </main>
    </div>
  );
}
