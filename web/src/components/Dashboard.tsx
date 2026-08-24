import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useLocation, useMatch } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAtom, useSetAtom } from 'jotai';
import type { ConnectionStatus, Session } from '../types';
import { useDashboardDialogs } from '../hooks/useDashboardDialogs';
import { useDashboard } from '../hooks/useDashboard';
import { useProbePolling } from '../hooks/useProbePolling';
import { useDeepLinkRestore } from '../hooks/useDeepLinkRestore';
import {
  hasActiveSessionAtom, sessionIdAtom, sessionIdFromUrlAtom, attachInfoAtom, sessionNameAtom,
  attachToSessionAtom, disconnectAtom, attachDialogSessionAtom,
} from '../atoms/session';
import { saveAttachPrefs } from '../services/attachPrefs';
import { type AttachChoice } from './env/AttachDialog';
import { AgentSection } from './AgentSection';
import { DashboardHeader } from './DashboardHeader';
import { RenderTerminal } from './RenderTerminal';
import { EnvManager } from './env/EnvManager';
import { SessionsSection } from './SessionsSection';
import { AgentDetailPanel } from './AgentDetailPanel';
import { DashboardDialogs } from './DashboardDialogs';
export { AgentSection };

interface DashboardProps {
  connectionStatus: ConnectionStatus;
}

/** Route guard: returns the correct view or null to continue to main dashboard. */
function resolveRouteView(opts: {
  terminalMatch: ReturnType<typeof useMatch>; envMatch: ReturnType<typeof useMatch>;
  connectionStatus: ConnectionStatus;
  hasActiveSession: boolean; sessionId: string;
  handleBackToDashboard: () => void;
  handleTerminalDisconnect: () => void; handleTerminalError: (err: Error) => void;
  agents: ReturnType<typeof useDashboard>['agents']; navigate: ReturnType<typeof useNavigate>;
}): ReactNode {
  const { terminalMatch, envMatch, connectionStatus, hasActiveSession, sessionId,
    handleBackToDashboard, handleTerminalDisconnect, handleTerminalError, agents, navigate } = opts;
  if (terminalMatch && hasActiveSession) {
    return (<RenderTerminal key={sessionId}
      handleBackToDashboard={handleBackToDashboard}
      handleTerminalDisconnect={handleTerminalDisconnect}
      handleTerminalError={handleTerminalError} />);
  }

  if (terminalMatch && !hasActiveSession) {
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center bg-background gap-3">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Restoring terminal session…</p>
      </div>
    );
  }

  if (envMatch) {
    return <EnvManager agents={agents} onBack={() => navigate('/')} />;
  }

  if (connectionStatus === 'disconnected') {
    return <Navigate to="/login" replace />;
  }

  return null;
}

/**
 * Owns the attach-dialog state and wires the attach/back actions to the jotai
 * atoms. Also handles deep-link restoration for /terminal/:sessionId.
 */
function useTerminalAttach(
  navigate: ReturnType<typeof useNavigate>,
  location: ReturnType<typeof useLocation>,
  sessions: Session[],
  loadingSessions: boolean,
) {
  const [hasActiveSession] = useAtom(hasActiveSessionAtom);
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [sessionIdFromUrl, setSessionIdFromUrl] = useAtom(sessionIdFromUrlAtom);
  const doAttach = useSetAtom(attachToSessionAtom);
  const doDisconnect = useSetAtom(disconnectAtom);

  // Deep-link restore: parse session ID from URL.
  useEffect(() => {
    setSessionIdFromUrl(location.pathname.match(/^\/terminal\/(.+)$/)?.[1] ?? null);
  }, [location.pathname, setSessionIdFromUrl]);

  const [attachDialogSession, setAttachDialogSession] = useAtom(attachDialogSessionAtom);

  const onAttach = useCallback(
    (session: Session) => setAttachDialogSession(session),
    [setAttachDialogSession],
  );

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachDialogSession(null);
    saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });
    doAttach({ session, choice, navigate });
  }, [doAttach, navigate, setAttachDialogSession]);

  // Deep-link restoration: on /terminal/:sessionId, auto-attach the session.
  useDeepLinkRestore({
    pendingSessionId: sessionIdFromUrl,
    attachedSession: hasActiveSession && attachInfo ? { sessionId, sessionName, attachInfo } : null,
    loadingSessions,
    sessions,
    confirmAttach,
    navigate,
  });

  return {
    hasActiveSession, sessionId, doDisconnect,
    attachDialogSession, setAttachDialogSession, onAttach, confirmAttach,
  };
}

export function Dashboard({ connectionStatus }: DashboardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const terminalMatch = useMatch('/terminal/:sessionId');
  const envMatch = useMatch('/env');

  const {
    agents, sessions, loadingSessions, loadingAgents, error, filteredAgents, filteredSessions,
    showCreateModal, sessionToKill, previewSession, searchQuery, setSearchQuery,
    statusFilter, setStatusFilter, isSearchActive, sortField, sortDirection, toggleSort,
    selectedAgent, setSelectedAgent, getHeartbeatHistory, setShowCreateModal, setSessionToKill,
    setPreviewSession, handleSessionKilled, handleSessionCreated, fetchSessions, clearError,
    updateAgent, staleAgents,
  } = useDashboard();

  const {
    hasActiveSession, sessionId, doDisconnect,
    attachDialogSession, setAttachDialogSession, onAttach, confirmAttach,
  } = useTerminalAttach(navigate, location, sessions, loadingSessions);

  const {
    serverRefreshKey, agentToDelete, setAgentToDelete,
    handleTerminalDisconnect, handleTerminalError, incrementServerRefreshKey,
  } = useDashboardDialogs();

  // Preselected agent for Create Session dialog (opened from detail panel).
  const [createSessionAgentId, setCreateSessionAgentId] = useState<string | null>(null);

  // App-level address probing — fire-and-forget, writes probeResultsAtom.
  useProbePolling(agents);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const offlineCount = agents.filter((a) => a.status !== 'online').length;

  const routeView = resolveRouteView({
    terminalMatch, envMatch, connectionStatus, hasActiveSession, sessionId,
    handleBackToDashboard: () => doDisconnect(navigate),
    handleTerminalDisconnect,
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
          onAgentDelete={setAgentToDelete}
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
          onPreview={setPreviewSession}
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
          onRename={() => {
            document.getElementById(`rename-${selectedAgent.agent_id}`)?.click();
          }}
          onDelete={() => setAgentToDelete(selectedAgent)}
          onCreateSession={() => {
            setCreateSessionAgentId(selectedAgent.agent_id);
            setShowCreateModal(true);
          }}
        />
      )}

      <DashboardDialogs
        showCreateModal={showCreateModal}
        setShowCreateModal={(show) => {
          setShowCreateModal(show);
          if (!show) {setCreateSessionAgentId(null);}
        }}
        agents={agents}
        onCreated={() => { handleSessionCreated(); incrementServerRefreshKey(); }}
        preselectedAgentId={createSessionAgentId}
        sessionToKill={sessionToKill} setSessionToKill={setSessionToKill} onKilled={handleSessionKilled}
        agentToDelete={agentToDelete} setAgentToDelete={setAgentToDelete}
        onDeleted={() => { incrementServerRefreshKey(); fetchSessions(); }}
        attachDialogSession={attachDialogSession} setAttachDialogSession={setAttachDialogSession}
        onConfirm={confirmAttach}
        previewSession={previewSession} setPreviewSession={setPreviewSession}
      />
    </div>
  );
}
