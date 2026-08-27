import { useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Agent, ConnectionStatus, Session } from '../types';
import type { useDashboard } from '../hooks/useDashboard';
import { type AttachChoice } from './env/AttachDialog';
import { AgentSection } from './AgentSection';
import { DashboardHeader } from './DashboardHeader';
import { SessionsSection } from './SessionsSection';
import { AgentDetailPanel } from './AgentDetailPanel';
import { DashboardDialogs } from './DashboardDialogs';

type DashboardData = ReturnType<typeof useDashboard>;

export interface DashboardMainViewProps {
  connectionStatus: ConnectionStatus;
  navigate: NavigateFunction;
  data: DashboardData;
  attachDialogSession: Session | null;
  setAttachDialogSession: (s: Session | null) => void;
  onAttach: (session: Session) => void;
  confirmAttach: (session: Session, choice: AttachChoice) => void;
  serverRefreshKey: number;
  agentToDelete: Agent | null;
  setAgentToDelete: (a: Agent | null) => void;
  incrementServerRefreshKey: () => void;
}

export function DashboardMainView({
  connectionStatus,
  navigate,
  data,
  attachDialogSession,
  setAttachDialogSession,
  onAttach,
  confirmAttach,
  serverRefreshKey,
  agentToDelete,
  setAgentToDelete,
  incrementServerRefreshKey,
}: DashboardMainViewProps) {
  const [createSessionAgentId, setCreateSessionAgentId] = useState<string | null>(null);

  const onlineCount = data.agents.filter((a) => a.status === 'online').length;
  const offlineCount = data.agents.filter((a) => a.status !== 'online').length;

  return (
    <div className="h-[100dvh] flex flex-col bg-background">
      <DashboardHeader
        connectionStatus={connectionStatus}
        searchProps={{
          query: data.searchQuery,
          setQuery: data.setSearchQuery,
          statusFilter: data.statusFilter,
          setStatusFilter: data.setStatusFilter,
          onlineCount,
          offlineCount,
        }}
        actionsProps={{
          fetchSessions: data.fetchSessions,
          onOpenEnv: () => navigate('/env'),
          loadingAgents: data.loadingAgents,
          clearError: data.clearError,
        }}
        error={data.error}
        serverRefreshKey={serverRefreshKey}
      />

      <div className="flex-1 min-h-0 flex flex-col p-3 gap-4 md:p-4 lg:p-6 lg:gap-6 pb-[env(safe-area-inset-bottom)] w-full max-w-[1920px] mx-auto">
        <AgentSection
          loadingAgents={data.loadingAgents}
          agents={data.agents}
          filteredAgents={data.filteredAgents}
          isSearchActive={data.isSearchActive}
          setSelectedAgent={data.setSelectedAgent}
          onAgentRename={data.updateAgent}
          onAgentDelete={setAgentToDelete}
        />

        <SessionsSection
          agents={data.agents}
          filteredSessions={data.filteredSessions}
          loadingSessions={data.loadingSessions}
          staleAgents={data.staleAgents}
          onCreate={() => data.setShowCreateModal(true)}
          fetchSessions={data.fetchSessions}
          onAttach={onAttach}
          onKill={data.setSessionToKill}
          onPreview={data.setPreviewSession}
          sortField={data.sortField}
          sortDirection={data.sortDirection}
          toggleSort={data.toggleSort}
          isSearchActive={data.isSearchActive}
        />
      </div>

      {data.selectedAgent && (
        <AgentDetailPanel
          agent={data.selectedAgent}
          heartbeatHistory={data.getHeartbeatHistory(data.selectedAgent.agent_id)}
          sessions={data.sessions.filter((s) => s.agent_id === data.selectedAgent!.agent_id)}
          onClose={() => data.setSelectedAgent(null)}
          onRefresh={data.fetchSessions}
          onRename={() => {
            document.getElementById(`rename-${data.selectedAgent!.agent_id}`)?.click();
          }}
          onDelete={() => setAgentToDelete(data.selectedAgent!)}
          onCreateSession={() => {
            setCreateSessionAgentId(data.selectedAgent!.agent_id);
            data.setShowCreateModal(true);
          }}
        />
      )}

      <DashboardDialogs
        showCreateModal={data.showCreateModal}
        setShowCreateModal={(show) => {
          data.setShowCreateModal(show);
          if (!show) { setCreateSessionAgentId(null); }
        }}
        agents={data.agents}
        onCreated={() => { data.handleSessionCreated(); incrementServerRefreshKey(); }}
        preselectedAgentId={createSessionAgentId}
        sessionToKill={data.sessionToKill} setSessionToKill={data.setSessionToKill}
        onKilled={data.handleSessionKilled}
        agentToDelete={agentToDelete} setAgentToDelete={setAgentToDelete}
        onDeleted={() => { incrementServerRefreshKey(); data.fetchSessions(); }}
        attachDialogSession={attachDialogSession} setAttachDialogSession={setAttachDialogSession}
        onConfirm={confirmAttach}
        previewSession={data.previewSession} setPreviewSession={data.setPreviewSession}
      />
    </div>
  );
}
