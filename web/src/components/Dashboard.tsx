import { useCallback, useEffect, type ReactNode } from 'react';
import { useNavigate, useMatch } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAtom, useSetAtom } from 'jotai';
import type { ConnectionStatus, Session } from '../types';
import { useDashboardDialogs } from '../hooks/useDashboardDialogs';
import { useDashboard } from '../hooks/useDashboard';
import { useDeepLinkRestore } from '../hooks/useDeepLinkRestore';
import {
  hasActiveSessionAtom, sessionIdAtom, sessionIdFromUrlAtom, attachInfoAtom, sessionNameAtom,
  attachToSessionAtom, disconnectAtom, attachDialogSessionAtom,
} from '../atoms/session';
import { saveAttachPrefs } from '../services/attachPrefs';
import { type AttachChoice } from './env/AttachDialog';
import { AgentSection } from './AgentSection';
import { RenderTerminal } from './RenderTerminal';
import { EnvManager } from './env/EnvManager';
import { DashboardMainView } from './DashboardMainView';
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
    return null;
  }

  return null;
}

function useTerminalAttach(opts: {
  navigate: ReturnType<typeof useNavigate>;
  terminalMatch: ReturnType<typeof useMatch>;
  sessions: Session[];
  sessionsLoaded: boolean;
  loadingSessions: boolean;
}) {
  const { navigate, terminalMatch, sessions, sessionsLoaded, loadingSessions } = opts;
  const [hasActiveSession] = useAtom(hasActiveSessionAtom);
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [sessionIdFromUrl, setSessionIdFromUrl] = useAtom(sessionIdFromUrlAtom);
  const doAttach = useSetAtom(attachToSessionAtom);
  const doDisconnect = useSetAtom(disconnectAtom);

  useEffect(() => {
    const raw = terminalMatch?.params?.sessionId;
    setSessionIdFromUrl(raw ? decodeURIComponent(raw) : null);
  }, [terminalMatch?.params?.sessionId, setSessionIdFromUrl]);

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

  useDeepLinkRestore({
    pendingSessionId: sessionIdFromUrl,
    attachedSession: hasActiveSession && attachInfo ? { sessionId, sessionName, attachInfo } : null,
    sessionsLoaded,
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
  const terminalMatch = useMatch('/terminal/:sessionId');
  const envMatch = useMatch('/env');
  const dashboardData = useDashboard();

  const {
    hasActiveSession, sessionId, doDisconnect,
    attachDialogSession, setAttachDialogSession, onAttach, confirmAttach,
  } = useTerminalAttach({
    navigate,
    terminalMatch,
    sessions: dashboardData.sessions,
    sessionsLoaded: dashboardData.sessionsLoaded,
    loadingSessions: dashboardData.loadingSessions,
  });

  const {
    serverRefreshKey, agentToDelete, setAgentToDelete,
    handleTerminalDisconnect, handleTerminalError, incrementServerRefreshKey,
  } = useDashboardDialogs();

  const routeView = resolveRouteView({
    terminalMatch, envMatch, connectionStatus, hasActiveSession, sessionId,
    handleBackToDashboard: () => doDisconnect(navigate),
    handleTerminalDisconnect,
    handleTerminalError, agents: dashboardData.agents, navigate,
  });
  if (routeView !== null) { return routeView; }

  return (
    <DashboardMainView
      connectionStatus={connectionStatus}
      navigate={navigate}
      data={dashboardData}
      attachDialogSession={attachDialogSession}
      setAttachDialogSession={setAttachDialogSession}
      onAttach={onAttach}
      confirmAttach={confirmAttach}
      serverRefreshKey={serverRefreshKey}
      agentToDelete={agentToDelete}
      setAgentToDelete={setAgentToDelete}
      incrementServerRefreshKey={incrementServerRefreshKey}
    />
  );
}
