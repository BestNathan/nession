import { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { CreateSessionDialog } from '@/components/CreateSessionDialog';
import { KillConfirmDialog } from '@/components/KillConfirmDialog';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/useDashboard';
import { useProbePolling } from '@/hooks/useProbePolling';
import { useSessionFirstAttach } from '@/hooks/useSessionFirstAttach';
import { p2pConnectionAtom } from '@/atoms/connection';
import { sessionIdAtom } from '@/atoms/session';
import { setSessionFirst } from '@/lib/sessionFirst';
import { createFileOps } from '@/services/fileOps';
import { mapDomainState } from '@/session-first/domainState';
import { SessionFirstMain } from '@/session-first/SessionFirstMain';
import { SessionFirstSidebar } from '@/session-first/SessionFirstSidebar';
import type { Surface } from '@/session-first/patterns/SessionHeader';
import type { WorkspaceToolId } from '@/session-first/patterns/WorkspaceNavigation';
import type { Session } from '@/types';

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

function SessionFirstDialogs({
  showCreateModal,
  setShowCreateModal,
  agents,
  handleSessionCreated,
  sessionToKill,
  setSessionToKill,
  onKilled,
}: {
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  agents: ReturnType<typeof useDashboard>['agents'];
  handleSessionCreated: () => void;
  sessionToKill: Session | null;
  setSessionToKill: (session: Session | null) => void;
  onKilled: () => void;
}) {
  return (
    <>
      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        agents={agents}
        preselectedAgentId={null}
        onCreated={handleSessionCreated}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        session={sessionToKill}
        onKilled={onKilled}
      />
    </>
  );
}

export function SessionFirstShell({ onLegacy }: SessionFirstShellProps) {
  const data = useDashboard();
  useProbePolling(data.agents);
  const clientSessionId = useAtomValue(sessionIdAtom);
  const p2pConnection = useAtomValue(p2pConnectionAtom);
  const { attachInFlightId, attachFailedId, attach } = useSessionFirstAttach();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('terminal');
  const [tool, setTool] = useState<WorkspaceToolId>('files');

  const selectedSession = selectedId
    ? data.sessions.find((session) => session.session_id === selectedId) ?? null
    : null;
  const selectedAgent = selectedSession
    ? data.agents.find((a) => a.agent_id === selectedSession.agent_id)
    : undefined;
  const domain = selectedSession
    ? mapDomainState({
        session: selectedSession,
        agent: selectedAgent,
        staleAgentIds: data.staleAgents,
        clientSessionId,
        attachInFlightId,
        attachFailedId,
      })
    : null;

  const fileOps = useMemo(() => {
    const sendMessage = p2pConnection?.sendMessage;
    const onMessage = p2pConnection?.onMessage;
    const waitForConnection = p2pConnection?.waitForConnection;
    return sendMessage && onMessage && waitForConnection
      ? createFileOps({ sendMessage, onMessage, waitForConnection })
      : null;
  }, [p2pConnection?.sendMessage, p2pConnection?.onMessage, p2pConnection?.waitForConnection]);

  const onKilled = useCallback(() => {
    if (data.sessionToKill && data.sessionToKill.session_id === selectedId) {
      setSelectedId(null);
    }
    data.handleSessionKilled();
  }, [data, selectedId]);

  const handleSelect = useCallback((s: Session) => {
    setSelectedId(s.session_id);
    setSurface('terminal');
    setTool('files');
    void attach(s);
  }, [attach]);

  return (
    <>
      <div className="flex h-[100dvh]">
        <SessionFirstSidebar
          agents={data.agents}
          filteredSessions={data.filteredSessions}
          staleAgents={data.staleAgents}
          selectedId={selectedId}
          clientSessionId={clientSessionId}
          attachInFlightId={attachInFlightId}
          attachFailedId={attachFailedId}
          loadingSessions={data.loadingSessions}
          searchQuery={data.searchQuery}
          setSearchQuery={data.setSearchQuery}
          statusFilter={data.statusFilter}
          setStatusFilter={data.setStatusFilter}
          sortField={data.sortField}
          sortDirection={data.sortDirection}
          toggleSort={data.toggleSort}
          isSearchActive={data.isSearchActive}
          onCreate={() => data.setShowCreateModal(true)}
          onRefresh={() => {
            void data.fetchSessions({ force: true });
          }}
          onSelect={handleSelect}
          onKill={(s) => data.setSessionToKill(s)}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
            <LegacyToggle onLegacy={onLegacy} />
          </div>
          <SessionFirstMain
            selectedSession={selectedSession}
            selectedAgent={selectedAgent}
            domain={domain}
            surface={surface}
            tool={tool}
            fileOps={fileOps}
            onSurfaceChange={setSurface}
            onToolChange={setTool}
            onOpenAgent={() => {
              setSurface('workspace');
              setTool('agent');
            }}
          />
        </main>
      </div>
      <SessionFirstDialogs
        showCreateModal={data.showCreateModal}
        setShowCreateModal={data.setShowCreateModal}
        agents={data.agents}
        handleSessionCreated={data.handleSessionCreated}
        sessionToKill={data.sessionToKill}
        setSessionToKill={data.setSessionToKill}
        onKilled={onKilled}
      />
    </>
  );
}
