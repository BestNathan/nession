import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, Session, AttachInfo, ConnectionStatus } from '../types';
import type { WebSocketService } from '../services/websocket';
import { Terminal, type TerminalHandle } from './Terminal';
import { ControlPanel } from './ControlPanel';
import { CreateSessionModal } from './CreateSessionModal';
import { ConfirmKillModal } from './ConfirmKillModal';
import './Dashboard.css';

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

  // Terminal view state
  const [view, setView] = useState<View>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachingInProgress, setAttachingInProgress] = useState(false);

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);

  // ── Data fetching ──────────────────────────────────────────────────

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try {
      const data = await wsService.listAgents();
      setAgents(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch agents';
      setError(msg);
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
    } finally {
      setLoadingSessions(false);
    }
  }, [wsService]);

  // ── Subscribe to live events from the server ───────────────────────

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

  // Initial load
  useEffect(() => {
    fetchAgents();
    fetchSessions();
  }, [fetchAgents, fetchSessions]);

  // ── Agent click → filter sessions ──────────────────────────────────

  const handleAgentClick = useCallback((agentId: string) => {
    setSelectedAgentId((prev) => (prev === agentId ? null : agentId));
  }, []);

  // Filtered sessions list
  const filteredSessions = selectedAgentId
    ? sessions.filter((s) => s.agent_id === selectedAgentId)
    : sessions;

  // ── Attach to session ──────────────────────────────────────────────

  const handleAttach = useCallback(
    async (session: Session) => {
      setAttachingInProgress(true);
      setError(null);
      try {
        // Request attach, prefer P2P, fallback to relay
        let attachInfo: AttachInfo;
        try {
          attachInfo = await wsService.requestAttach(session.session_id, 'p2p');
        } catch {
          // Fallback to relay if P2P fails
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
      } finally {
        setAttachingInProgress(false);
      }
    },
    [wsService],
  );

  // ── Detach / back to dashboard ─────────────────────────────────────

  const handleBackToDashboard = useCallback(() => {
    setAttachedSession(null);
    setView('dashboard');
    // Refresh sessions list (attach counts may have changed)
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  const handleTerminalDisconnect = useCallback(() => {
    setError('Terminal connection lost');
    handleBackToDashboard();
  }, [handleBackToDashboard]);

  const handleTerminalError = useCallback(
    (err: Error) => {
      setError(`Terminal error: ${err.message}`);
      handleBackToDashboard();
    },
    [handleBackToDashboard],
  );

  // ── Modal handlers ───────────────────────────────────────────────

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

  // ── Manual refresh ─────────────────────────────────────────────────

  const handleRefreshAgents = useCallback(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleRefreshSessions = useCallback(() => {
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  // ── Render ─────────────────────────────────────────────────────────

  if (view === 'terminal' && attachedSession) {
    return <TerminalView session={attachedSession} wsService={wsService} onBack={handleBackToDashboard} onDisconnect={handleTerminalDisconnect} onError={handleTerminalError} />;
  }

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h1 className="dashboard-title">Nession</h1>
        </div>
        <div className="dashboard-header-right">
          <ConnectionStatusBadge status={connectionStatus} />
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="dashboard-error">
          <span>{error}</span>
          <button className="error-dismiss" onClick={() => setError(null)}>
            &times;
          </button>
        </div>
      )}

      {/* Two-panel layout */}
      <div className="dashboard-panels">
        {/* Agents Panel */}
        <section className="panel agents-panel">
          <div className="panel-header">
            <h2>Agents</h2>
            <button className="btn-refresh" onClick={handleRefreshAgents} disabled={loadingAgents} title="Refresh agents">
              {loadingAgents ? '⟳' : '↻'}
            </button>
          </div>
          <div className="panel-body">
            {agents.length === 0 && !loadingAgents ? (
              <p className="empty-message">No agents found</p>
            ) : (
              <ul className="item-list">
                {agents.map((agent) => (
                  <li
                    key={agent.agent_id}
                    className={`agent-item ${selectedAgentId === agent.agent_id ? 'selected' : ''}`}
                    onClick={() => handleAgentClick(agent.agent_id)}
                  >
                    <span className={`status-dot status-${agent.status}`} />
                    <div className="agent-info">
                      <span className="agent-hostname">{agent.hostname}</span>
                      <span className="agent-meta">
                        {agent.status} &middot; {agent.session_count} sess
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {loadingAgents && <p className="loading-message">Loading agents...</p>}
          </div>
        </section>

        {/* Sessions Panel */}
        <section className="panel sessions-panel">
          <div className="panel-header">
            <h2>
              Sessions
              {selectedAgentId && (
                <span className="filter-badge">
                  {agents.find((a) => a.agent_id === selectedAgentId)?.hostname ?? selectedAgentId}
                  <button className="filter-clear" onClick={() => setSelectedAgentId(null)} title="Clear filter">
                    &times;
                  </button>
                </span>
              )}
            </h2>
            <div className="panel-header-actions">
              <button
                className="btn-create-session"
                onClick={handleCreateSession}
                title="Create new session"
              >
                + Create
              </button>
              <button className="btn-refresh" onClick={handleRefreshSessions} disabled={loadingSessions} title="Refresh sessions">
                {loadingSessions ? '⟳' : '↻'}
              </button>
            </div>
          </div>
          <div className="panel-body">
            {filteredSessions.length === 0 && !loadingSessions ? (
              <p className="empty-message">
                {selectedAgentId ? 'No sessions for this agent' : 'No sessions found'}
              </p>
            ) : (
              <ul className="item-list">
                {filteredSessions.map((session) => (
                  <li key={session.session_id} className="session-item">
                    <span className={`status-dot status-${session.status === 'active' ? 'active' : 'detached'}`} />
                    <div className="session-info">
                      <span className="session-name">{session.session_name}</span>
                      <span className="session-meta">
                        {session.agent_id} &middot; {session.window_count} win &middot; {session.attached_clients} client
                        {session.attached_clients !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="session-actions">
                      <button
                        className="btn-attach"
                        onClick={() => handleAttach(session)}
                        disabled={attachingInProgress}
                      >
                        {attachingInProgress ? '...' : 'Attach'}
                      </button>
                      <button
                        className="btn-kill"
                        onClick={() => handleKillClick(session)}
                        title="Kill session"
                      >
                        Kill
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {loadingSessions && <p className="loading-message">Loading sessions...</p>}
          </div>
        </section>
      </div>

      {/* Modals */}
      <CreateSessionModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        wsService={wsService}
        agents={agents}
        preselectedAgentId={selectedAgentId}
        onCreated={handleSessionCreated}
      />
      <ConfirmKillModal
        isOpen={sessionToKill !== null}
        onClose={() => setSessionToKill(null)}
        wsService={wsService}
        session={sessionToKill}
        onKilled={handleSessionKilled}
      />
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const labels: Record<ConnectionStatus, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    connected: 'Connected',
    authenticated: 'Authenticated',
  };
  return (
    <div className={`connection-badge connection-${status}`}>
      <span className="connection-dot" />
      <span className="connection-label">{labels[status]}</span>
    </div>
  );
}

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

  return (
    <div className="terminal-view">
      <header className="terminal-view-header">
        <button className="btn-back" onClick={onBack}>
          &larr; Back to Dashboard
        </button>
        <span className="terminal-view-title">
          Session: <strong>{sessionName}</strong>
          <span className={`mode-badge mode-${attachInfo.mode}`}>{attachInfo.mode.toUpperCase()}</span>
        </span>
      </header>
      <div className="terminal-view-body">
        <Terminal
          ref={terminalRef}
          sessionId={sessionId}
          sessionName={sessionName}
          mode={attachInfo.mode}
          agentUrl={isP2P ? attachInfo.agent_address : undefined}
          connectionToken={isP2P ? attachInfo.connection_token : undefined}
          serverConnection={!isP2P ? wsService : undefined}
          onDisconnect={onDisconnect}
          onError={onError}
        />
        <ControlPanel sendText={(text) => terminalRef.current?.sendText(text)} />
      </div>
    </div>
  );
}
