import { useState, useCallback } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Agent, Session, ConnectionStatus } from '../types';
import type { WebSocketService } from '../services/websocket';
import { TerminalView, type AttachedSession } from './TerminalView';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AgentCard } from './AgentCard';
import { SessionList } from './SessionList';
import { SearchBar } from './SearchBar';
import { AgentDetailPanel } from './AgentDetailPanel';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
import { useDashboardHandlers } from './useDashboardHandlers';

interface DashboardProps {
  wsService: WebSocketService;
  connectionStatus: ConnectionStatus;
}

type View = 'dashboard' | 'terminal';

function AgentSection({
  loadingAgents,
  agents,
  filteredAgents,
  isSearchActive,
  setSelectedAgent,
}: {
  loadingAgents: boolean;
  agents: Agent[];
  filteredAgents: Agent[];
  isSearchActive: boolean;
  setSelectedAgent: (a: Agent | null) => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Agents</h2>
      </div>
      {loadingAgents ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        </div>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No agents connected</p>
      ) : filteredAgents.length === 0 && isSearchActive ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No agents match your search</p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {filteredAgents.map((a) => (
            <AgentCard key={a.agent_id} agent={a} onClick={() => setSelectedAgent(a)} />
          ))}
        </div>
      )}
    </section>
  );
}

function DashboardHeader({
  connectionStatus,
  loadingAgents,
  fetchSessions,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onlineCount,
  offlineCount,
  error,
}: {
  connectionStatus: ConnectionStatus;
  loadingAgents: boolean;
  fetchSessions: () => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  statusFilter: import('./useDashboardHandlers').StatusFilter;
  setStatusFilter: (f: import('./useDashboardHandlers').StatusFilter) => void;
  onlineCount: number;
  offlineCount: number;
  error: string | null;
}) {
  return (
    <>
      <header className="border-b px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <h1 className="text-lg font-bold">Nession</h1>
        <Badge variant="outline" className="gap-1.5 py-1.5">
          <span className={cn('w-2 h-2 rounded-full',
            connectionStatus === 'authenticated' ? 'bg-green-500' : 'bg-red-500',
            connectionStatus === 'connecting' && 'animate-pulse bg-amber-500',
          )} />
          {connectionStatus}
        </Badge>
        <div className="flex-1" />
        <Button size="sm" onClick={() => fetchSessions()} disabled={loadingAgents}>
          <RefreshCw className={cn('w-4 h-4', loadingAgents && 'animate-spin')} />
        </Button>
      </header>
      <SearchBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
      />
      {error && (
        <div className="px-6 py-2 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <span>{error}</span>
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {}}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </>
  );
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

export function Dashboard({ wsService, connectionStatus }: DashboardProps) {
  const [view, setView] = useState<View>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);

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
    handleAttach, handleSessionKilled, handleSessionCreated,
    fetchSessions,
  } = useDashboardHandlers(wsService);

  const onAttach = useCallback(async (session: Session) => {
    await handleAttach(session);
    const attached = (handleAttach as unknown as { _attached?: AttachedSession })._attached;
    if (attached) { setAttachedSession(attached); setView('terminal'); }
  }, [handleAttach]);

  const handleBackToDashboard = useCallback(() => {
    setAttachedSession(null);
    setView('dashboard');
    fetchSessions();
  }, [fetchSessions]);

  const handleTerminalDisconnect = useCallback(() => {
    toast.error('Terminal connection lost');
    handleBackToDashboard();
  }, [handleBackToDashboard]);

  const handleTerminalError = useCallback((err: Error) => { toast.error(`Terminal error: ${err.message}`); }, []);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const offlineCount = agents.filter((a) => a.status !== 'online').length;

  if (view === 'terminal' && attachedSession) {
    return (<RenderTerminal attachedSession={attachedSession} wsService={wsService}
      handleBackToDashboard={handleBackToDashboard} handleTerminalDisconnect={handleTerminalDisconnect}
      handleTerminalError={handleTerminalError} />);
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <DashboardHeader
        connectionStatus={connectionStatus}
        loadingAgents={loadingAgents}
        fetchSessions={fetchSessions}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onlineCount={onlineCount}
        offlineCount={offlineCount}
        error={error}
      />

      <div className="flex-1 min-h-0 flex flex-col p-6 gap-6">
        <AgentSection
          loadingAgents={loadingAgents}
          agents={agents}
          filteredAgents={filteredAgents}
          isSearchActive={isSearchActive}
          setSelectedAgent={setSelectedAgent}
        />

        {/* Sessions */}
        <section className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions
            </h2>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setShowCreateModal(true)} disabled={agents.every((a) => a.status !== 'online')}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => fetchSessions()} disabled={loadingSessions}>
                <RefreshCw className={cn('w-3.5 h-3.5', loadingSessions && 'animate-spin')} />
              </Button>
            </div>
          </div>
          <SessionList
            sessions={filteredSessions}
            loading={loadingSessions}
            onAttach={onAttach}
            onKill={setSessionToKill}
            attachingInProgress={attachingInProgress}
            sortField={sortField}
            sortDirection={sortDirection}
            toggleSort={toggleSort}
            isSearchActive={isSearchActive}
          />
        </section>
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
    </div>
  );
}
