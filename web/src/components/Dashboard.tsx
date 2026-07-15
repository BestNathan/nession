import { useCallback } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { Agent, Session, ConnectionStatus } from '../types';
import type { WebSocketService } from '../services/websocket';
import { TerminalView, type AttachedSession } from './TerminalView';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { SessionList } from './SessionList';
import { AgentDetailPanel } from './AgentDetailPanel';
import { EnvManager } from './env/EnvManager';
import { AttachDialog } from './env/AttachDialog';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { useDashboardHandlers } from './useDashboardHandlers';
import { useAttachFlow } from './useAttachFlow';
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { AgentSection } from './AgentSection';
import { DashboardHeader } from './DashboardHeader';
export { AgentSection };

interface DashboardProps {
  wsService: WebSocketService;
  connectionStatus: ConnectionStatus;
}

function RenderTerminal({
  attachedSession, wsService, handleBackToDashboard, handleTerminalDisconnect, handleTerminalError,
}: { attachedSession: AttachedSession; wsService: WebSocketService;
  handleBackToDashboard: () => void; handleTerminalDisconnect: () => void;
  handleTerminalError: (err: Error) => void; }) {
  return (
    <TerminalView session={attachedSession} wsService={wsService}
      onBack={handleBackToDashboard} onDisconnect={handleTerminalDisconnect} onError={handleTerminalError} />
  );
}

function SessionsSection({
  agents, filteredSessions, loadingSessions, attachingInProgress,
  onCreate, fetchSessions, onAttach, onKill,
  sortField, sortDirection, toggleSort, isSearchActive,
}: {
  agents: Agent[];
  filteredSessions: Session[];
  loadingSessions: boolean;
  attachingInProgress: boolean;
  onCreate: () => void;
  fetchSessions: () => void;
  onAttach: (s: Session) => void;
  onKill: (s: Session) => void;
  sortField: import('./useDashboardHandlers').SortField;
  sortDirection: import('./useDashboardHandlers').SortDirection;
  toggleSort: (f: import('./useDashboardHandlers').SortField) => void;
  isSearchActive: boolean;
}) {
  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Sessions
        </h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={onCreate} disabled={agents.every((a) => a.status !== 'online')} className="min-h-11 md:min-h-7">
            <Plus className="w-3.5 h-3.5 mr-1" /> Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => fetchSessions()} disabled={loadingSessions} className="min-h-11 min-w-11 md:min-h-7 md:min-w-0">
            <RefreshCw className={cn('w-3.5 h-3.5', loadingSessions && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <SessionList
        sessions={filteredSessions}
        loading={loadingSessions}
        onAttach={onAttach}
        onKill={onKill}
        attachingInProgress={attachingInProgress}
        sortField={sortField}
        sortDirection={sortDirection}
        toggleSort={toggleSort}
        isSearchActive={isSearchActive}
      />
    </section>
  );
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
