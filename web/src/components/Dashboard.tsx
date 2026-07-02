import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, RefreshCw, X, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import type { Agent, Session, AttachInfo, ConnectionStatus } from '../types';
import type { WebSocketService } from '../services/websocket';
import { Terminal, type TerminalHandle } from './Terminal';
import { TerminalToolbar } from './TerminalToolbar';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AgentCard } from './AgentCard';
import { SessionList } from './SessionList';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
import { useP2PConnection } from '../hooks/useP2PConnection';
import { createFileOps } from '../services/fileOps';
import { FileTabs } from './FileTabs';

export interface DashboardProps {
  wsService: WebSocketService;
  connectionStatus: ConnectionStatus;
}

type View = 'dashboard' | 'terminal';

interface AttachedSession {
  sessionId: string;
  sessionName: string;
  attachInfo: AttachInfo;
}

export function Dashboard({ wsService, connectionStatus }: DashboardProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachingInProgress, setAttachingInProgress] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try {
      const data = await wsService.listAgents();
      setAgents(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch agents';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoadingAgents(false);
    }
  }, [wsService]);

  const fetchSessions = useCallback(async (agentId?: string) => {
    setLoadingSessions(true);
    setError(null);
    try {
      const data = await wsService.listSessions(agentId);
      setSessions(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoadingSessions(false);
    }
  }, [wsService]);

  useEffect(() => {
    const unsubAgents = wsService.onAgentsChanged((newAgents) => {
      setAgents(newAgents);
    });
    const unsubSessions = wsService.onSessionsChanged((newSessions) => {
      setSessions(newSessions);
    });
    return () => {
      unsubAgents();
      unsubSessions();
    };
  }, [wsService]);

  useEffect(() => {
    fetchAgents();
    fetchSessions();
  }, [fetchAgents, fetchSessions]);

  const handleAgentClick = useCallback((agentId: string) => {
    setSelectedAgentId((prev) => (prev === agentId ? null : agentId));
  }, []);

  const filteredSessions = selectedAgentId
    ? sessions.filter((s) => s.agent_id === selectedAgentId)
    : sessions;

  const handleAttach = useCallback(
    async (session: Session) => {
      setAttachingInProgress(true);
      setError(null);
      try {
        let attachInfo: AttachInfo;
        try {
          attachInfo = await wsService.requestAttach(session.session_id, 'p2p');
        } catch {
          attachInfo = await wsService.requestAttach(session.session_id, 'relay');
        }

        setAttachedSession({
          sessionId: session.session_id,
          sessionName: session.session_name,
          attachInfo,
        });
        setView('terminal');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to attach to session';
        setError(msg);
        toast.error(msg);
      } finally {
        setAttachingInProgress(false);
      }
    },
    [wsService],
  );

  const handleBackToDashboard = useCallback(() => {
    setAttachedSession(null);
    setView('dashboard');
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  const handleTerminalDisconnect = useCallback(() => {
    toast.error('Terminal connection lost');
    handleBackToDashboard();
  }, [handleBackToDashboard]);

  const handleTerminalError = useCallback(
    (err: Error) => {
      toast.error(`Terminal error: ${err.message}`);
      handleBackToDashboard();
    },
    [handleBackToDashboard],
  );

  const handleCreateSession = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  const handleSessionCreated = useCallback(() => {
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  const handleKillClick = useCallback((session: Session) => {
    setSessionToKill(session);
  }, []);

  const handleSessionKilled = useCallback(() => {
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  const handleRefreshAgents = useCallback(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleRefreshSessions = useCallback(() => {
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  // ── Terminal View ───────────────────────────────────────────────────

  if (view === 'terminal' && attachedSession) {
    return (
      <TerminalView
        session={attachedSession}
        wsService={wsService}
        onBack={handleBackToDashboard}
        onDisconnect={handleTerminalDisconnect}
        onError={handleTerminalError}
      />
    );
  }

  // ── Dashboard View ─────────────────────────────────────────────────

  const connectionLabels: Record<ConnectionStatus, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    connected: 'Connected',
    authenticated: 'Authenticated',
  };

  const connectionDotColor: Record<ConnectionStatus, string> = {
    disconnected: 'bg-red-500',
    connecting: 'bg-amber-500 animate-pulse',
    connected: 'bg-green-500',
    authenticated: 'bg-blue-500',
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b px-6 py-3 flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-bold">Nession</h1>
        <div className="flex items-center gap-2">
          {error ? <span className="hidden">{error}</span> : null}
          <Badge variant="outline" className="gap-1.5 py-1.5">
            <span className={`w-2 h-2 rounded-full ${connectionDotColor[connectionStatus]}`} />
            {connectionLabels[connectionStatus]}
          </Badge>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {/* Agents section bar */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Agents</h2>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleCreateSession}>
              <Plus className="w-4 h-4 mr-1" /> Create
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefreshAgents}
              disabled={loadingAgents}
              title="Refresh agents"
            >
              <RefreshCw className={cn('w-4 h-4', loadingAgents && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {/* Agent cards grid */}
        {loadingAgents ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <p className="text-muted-foreground text-center py-16">
            No agents connected
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((agent) => (
              <AgentCard
                key={agent.agent_id}
                agent={agent}
                selected={selectedAgentId === agent.agent_id}
                onClick={() => handleAgentClick(agent.agent_id)}
              />
            ))}
          </div>
        )}

        {/* Sessions panel */}
        {selectedAgentId && (
          <div className="mt-6">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-sm">
                Sessions ·{' '}
                {agents.find((a) => a.agent_id === selectedAgentId)?.hostname ?? selectedAgentId}
              </h3>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setSelectedAgentId(null)}
                title="Clear filter"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleRefreshSessions}
                disabled={loadingSessions}
                title="Refresh sessions"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', loadingSessions && 'animate-spin')} />
              </Button>
            </div>
            <SessionList
              sessions={filteredSessions}
              loading={loadingSessions}
              onAttach={handleAttach}
              onKill={handleKillClick}
              attachingInProgress={attachingInProgress}
            />
          </div>
        )}
      </main>

      {/* Modals (will cause TS errors until Tasks 5 creates them — expected) */}
      <CreateSessionDialog
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        wsService={wsService}
        agents={agents}
        preselectedAgentId={selectedAgentId}
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

// ── TerminalView ──────────────────────────────────────────────────────

interface TerminalViewProps {
  session: AttachedSession;
  wsService: WebSocketService;
  onBack: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

function TerminalView({ session, wsService, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName } = session;
  const isP2P = attachInfo.mode === 'p2p';
  const terminalRef = useRef<TerminalHandle>(null);

  const p2pConnection = useP2PConnection(
    isP2P && attachInfo.agent_address
      ? {
          agentUrl: attachInfo.agent_address,
          connectionToken: attachInfo.connection_token,
          sessionName,
        }
      : null,
  );

  const fileOps = p2pConnection ? createFileOps(p2pConnection) : null;

  const terminalElement = (
    <Terminal
      ref={terminalRef}
      sessionId={sessionId}
      sessionName={sessionName}
      mode={attachInfo.mode}
      p2pConnection={isP2P ? p2pConnection : undefined}
      serverConnection={!isP2P ? wsService : undefined}
      onDisconnect={onDisconnect}
      onError={onError}
    />
  );

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <span className="text-sm text-muted-foreground">
          Session: <strong className="text-foreground">{sessionName}</strong>
        </span>
        <Badge variant={attachInfo.mode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
          {attachInfo.mode.toUpperCase()}
        </Badge>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {fileOps ? (
          <FileTabs
            fileOps={fileOps}
            terminalElement={
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">{terminalElement}</div>
                <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
              </div>
            }
          />
        ) : (
          <>
            <div className="flex-1 min-h-0">{terminalElement}</div>
            <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
          </>
        )}
      </div>
    </div>
  );
}
