import { useCallback } from 'react';
import { toast } from 'sonner';
import type { ConnectionStatus } from '../types';
import type { WebSocketService } from '../services/websocket';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AgentDetailPanel } from './AgentDetailPanel';
import { EnvManager } from './env/EnvManager';
import { AttachDialog } from './env/AttachDialog';
import { useDashboardHandlers } from './useDashboardHandlers';
import { useAttachFlow } from './useAttachFlow';
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { AgentSection } from './AgentSection';
import { DashboardHeader } from './DashboardHeader';
import { RenderTerminal } from './RenderTerminal';
import { SessionsSection } from './SessionsSection';
export { AgentSection };

interface DashboardProps {
  wsService: WebSocketService;
  connectionStatus: ConnectionStatus;
}

export function Dashboard({ wsService, connectionStatus }: DashboardProps) {
  const {
    agents, loadingAgents, loadingSessions, error,
    filteredAgents, filteredSessions, attachingInProgress,
    showCreateModal, sessionToKill,
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    isSearchActive,
    sortField, sortDirection, toggleSort,
    selectedAgent, setSelectedAgent,
    getHeartbeatHistory,
    setShowCreateModal, setSessionToKill,
    handleSessionKilled, handleSessionCreated,
    fetchSessions, clearError,
  } = useDashboardHandlers(wsService);

  const {
    view, setView,
    attachedSession,
    attachDialogSession, setAttachDialogSession,
    onAttach, confirmAttach,
    backToDashboard,
  } = useAttachFlow(fetchSessions);

  const probeCache = useAddressProbeCache(agents);

  const handleTerminalDisconnect = useCallback(() => {
    toast.error('Terminal connection lost');
    backToDashboard();
  }, [backToDashboard]);

  const handleTerminalError = useCallback((err: Error) => { toast.error(`Terminal error: ${err.message}`); }, []);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const offlineCount = agents.filter((a) => a.status !== 'online').length;

  if (view === 'terminal' && attachedSession) {
    return (<RenderTerminal attachedSession={attachedSession} wsService={wsService}
      handleBackToDashboard={backToDashboard} handleTerminalDisconnect={handleTerminalDisconnect}
      handleTerminalError={handleTerminalError} />);
  }

  if (view === 'env') {
    return <EnvManager wsService={wsService} agents={agents} onBack={() => setView('dashboard')} />;
  }

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
          onOpenEnv: () => setView('env'),
          loadingAgents,
          clearError,
        }}
        error={error}
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
        />

        {/* Sessions */}
        <SessionsSection
          agents={agents}
          filteredSessions={filteredSessions}
          loadingSessions={loadingSessions}
          attachingInProgress={attachingInProgress}
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

      {/* Agent Detail Panel */}
      {selectedAgent && (
        <AgentDetailPanel
          agent={selectedAgent}
          heartbeatHistory={getHeartbeatHistory(selectedAgent.agent_id)}
          onClose={() => setSelectedAgent(null)}
        />
      )}

      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        wsService={wsService}
        agents={agents}
        preselectedAgentId={null}
        onCreated={handleSessionCreated}
      />
      <KillConfirmDialog
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        wsService={wsService}
        session={sessionToKill}
        onKilled={handleSessionKilled}
      />
      <AttachDialog
        isOpen={attachDialogSession !== null}
        onClose={() => setAttachDialogSession(null)}
        session={attachDialogSession}
        wsService={wsService}
        onConfirm={confirmAttach}
        probeCache={probeCache}
      />
    </div>
  );
}
