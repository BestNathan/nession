import { useCallback, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useLocation, useMatch } from 'react-router-dom';
import { toast } from 'sonner';
import type { ConnectionStatus } from '../types';
import { useDashboard } from '../hooks/useDashboard';
import { useAttachFlow } from '../hooks/useAttachFlow';
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { useDeepLinkRestore } from '../hooks/useDeepLinkRestore';
import { AgentSection } from './AgentSection';
import { DashboardHeader } from './DashboardHeader';
import { RenderTerminal } from './RenderTerminal';
import { EnvManager } from './env/EnvManager';
import { SessionsSection } from './SessionsSection';
import { AgentDetailPanel } from './AgentDetailPanel';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AttachDialog } from './env/AttachDialog';
export { AgentSection };

interface DashboardProps {
  connectionStatus: ConnectionStatus;
}

/** Route guard: returns the correct view or null to continue to main dashboard. */
function resolveRouteView(opts: {
  terminalMatch: ReturnType<typeof useMatch>; envMatch: ReturnType<typeof useMatch>;
  connectionStatus: ConnectionStatus;
  attachedSession: ReturnType<typeof useAttachFlow>['attachedSession'];
  backToDashboard: () => void;
  handleTerminalDisconnect: () => void; handleTerminalError: (err: Error) => void;
  agents: ReturnType<typeof useDashboard>['agents']; navigate: ReturnType<typeof useNavigate>;
}): ReactNode {
  const { terminalMatch, envMatch, connectionStatus, attachedSession, backToDashboard,
    handleTerminalDisconnect, handleTerminalError, agents, navigate } = opts;
  if (terminalMatch && attachedSession) {
    return (<RenderTerminal key={attachedSession.sessionId} attachedSession={attachedSession}
      handleBackToDashboard={backToDashboard}
      handleTerminalDisconnect={handleTerminalDisconnect}
      handleTerminalError={handleTerminalError} />);
  }

  if (envMatch) {
    return <EnvManager agents={agents} onBack={() => navigate('/')} />;
  }

  if (connectionStatus === 'disconnected') {
    return <Navigate to="/login" replace />;
  }

  return null;
}

export function Dashboard({ connectionStatus }: DashboardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const terminalMatch = useMatch('/terminal/:sessionId');
  const envMatch = useMatch('/env');

  const {
    agents, sessions, loadingSessions, loadingAgents, error, filteredAgents, filteredSessions,
    showCreateModal, sessionToKill, searchQuery, setSearchQuery, statusFilter, setStatusFilter,
    isSearchActive, sortField, sortDirection, toggleSort, selectedAgent, setSelectedAgent,
    getHeartbeatHistory, setShowCreateModal, setSessionToKill, handleSessionKilled,
    handleSessionCreated, fetchSessions, clearError, updateAgent, staleAgents,
  } = useDashboard();

  const {
    attachedSession, attachDialogSession, setAttachDialogSession, onAttach, confirmAttach,
    backToDashboard, pendingTerminalSessionId,
  } = useAttachFlow(fetchSessions, navigate, location);

  const probeCache = useAddressProbeCache(agents);
  const handleTerminalDisconnect = useCallback(() => { toast.error('Terminal connection lost'); backToDashboard(); }, [backToDashboard]);
  const handleTerminalError = useCallback((err: Error) => { toast.error(`Terminal error: ${err.message}`); }, []);

  // Incremented after session create/kill to trigger server info refresh.
  const [serverRefreshKey, setServerRefreshKey] = useState(0);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const offlineCount = agents.filter((a) => a.status !== 'online').length;

  // Deep-link restoration: on /terminal/:sessionId, auto-attach the session.
  useDeepLinkRestore({
    pendingSessionId: pendingTerminalSessionId,
    attachedSession,
    loadingSessions,
    sessions,
    confirmAttach,
    navigate,
  });

  const routeView = resolveRouteView({
    terminalMatch, envMatch, connectionStatus, attachedSession,
    backToDashboard, handleTerminalDisconnect,
    handleTerminalError, agents, navigate,
  });
  if (routeView !== null) { return routeView; }

  return (
    <div className="h-[100dvh] flex flex-col bg-background">
      <DashboardHeader
        connectionStatus={connectionStatus}
        searchProps={{
          query: searchQuery,
          setQuery: setSearchQuery,
          statusFilter,
          setStatusFilter,
          onlineCount,
          offlineCount,
        }}
        actionsProps={{
          fetchSessions,
          onOpenEnv: () => navigate('/env'),
          loadingAgents,
          clearError,
        }}
        error={error}
        serverRefreshKey={serverRefreshKey}
      />

      <div className="flex-1 min-h-0 flex flex-col p-3 gap-4 md:p-4 lg:p-6 lg:gap-6 pb-[env(safe-area-inset-bottom)] w-full max-w-[1920px] mx-auto">
        <AgentSection
          loadingAgents={loadingAgents}
          agents={agents}
          filteredAgents={filteredAgents}
          isSearchActive={isSearchActive}
          setSelectedAgent={setSelectedAgent}
          onlineCount={onlineCount}
          offlineCount={offlineCount}
          onAgentRename={updateAgent}
        />

        {/* Sessions */}
        <SessionsSection
          agents={agents}
          filteredSessions={filteredSessions}
          loadingSessions={loadingSessions}
          staleAgents={staleAgents}
          onCreate={() => setShowCreateModal(true)}
          fetchSessions={fetchSessions}
          onAttach={onAttach}
          onKill={setSessionToKill}
          sortField={sortField}
          sortDirection={sortDirection}
          toggleSort={toggleSort}
          isSearchActive={isSearchActive}
        />
      </div>

      {selectedAgent && (
        <AgentDetailPanel
          agent={selectedAgent}
          heartbeatHistory={getHeartbeatHistory(selectedAgent.agent_id)}
          sessions={sessions.filter((s) => s.agent_id === selectedAgent.agent_id)}
          onClose={() => setSelectedAgent(null)}
          onRefresh={fetchSessions}
        />
      )}

      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        agents={agents}
        preselectedAgentId={null}
        onCreated={() => { handleSessionCreated(); setServerRefreshKey((n) => n + 1); }}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        session={sessionToKill}
        onKilled={handleSessionKilled}
      />
      <AttachDialog
        isOpen={attachDialogSession !== null}
        onClose={() => setAttachDialogSession(null)}
        session={attachDialogSession}
        onConfirm={confirmAttach}
        probeCache={probeCache}
      />
    </div>
  );
}
