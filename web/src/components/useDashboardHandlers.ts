import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { Agent, Session, AttachInfo } from '../types';
import type { WebSocketService } from '../services/websocket';
import type { AttachedSession } from './TerminalView';

export interface DashboardState {
  agents: Agent[];
  sessions: Session[];
  loadingAgents: boolean;
  loadingSessions: boolean;
  error: string | null;
  selectedAgentId: string | null;
  filteredSessions: Session[];
  attachingInProgress: boolean;
  showCreateModal: boolean;
  sessionToKill: Session | null;
  setSelectedAgentId: (id: string | null) => void;
  setShowCreateModal: (show: boolean) => void;
  setSessionToKill: (s: Session | null) => void;
  handleAgentClick: (agentId: string) => void;
  handleAttach: (session: Session) => void;
  handleSessionKilled: () => void;
  handleSessionCreated: () => void;
  fetchSessions: (agentId?: string) => Promise<void>;
}

export function useDashboardHandlers(wsService: WebSocketService): DashboardState {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [attachingInProgress, setAttachingInProgress] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try { setAgents(await wsService.listAgents()); }
    catch (err) { const msg = err instanceof Error ? err.message : 'Failed to fetch agents'; setError(msg); toast.error(msg); }
    finally { setLoadingAgents(false); }
  }, [wsService]);

  const fetchSessions = useCallback(async (agentId?: string) => {
    setLoadingSessions(true);
    setError(null);
    try { setSessions(await wsService.listSessions(agentId)); }
    catch (err) { const msg = err instanceof Error ? err.message : 'Failed to fetch sessions'; setError(msg); toast.error(msg); }
    finally { setLoadingSessions(false); }
  }, [wsService]);

  useEffect(() => {
    const u1 = wsService.onAgentsChanged(setAgents);
    const u2 = wsService.onSessionsChanged(setSessions);
    return () => { u1(); u2(); };
  }, [wsService]);

  useEffect(() => { fetchAgents(); fetchSessions(); }, [fetchAgents, fetchSessions]);

  const handleAgentClick = useCallback((agentId: string) => {
    setSelectedAgentId((prev) => (prev === agentId ? null : agentId));
  }, []);

  const filteredSessions = selectedAgentId
    ? sessions.filter((s) => s.agent_id === selectedAgentId)
    : sessions;

  const handleAttach = useCallback(async (session: Session) => {
    setAttachingInProgress(true);
    setError(null);
    try {
      let attachInfo: AttachInfo;
      try { attachInfo = await wsService.requestAttach(session.session_id, 'p2p'); }
      catch { attachInfo = await wsService.requestAttach(session.session_id, 'relay'); }
      // The caller (Dashboard) manages view state via returned AttachedSession
      (handleAttach as unknown as { _attached?: AttachedSession })._attached = {
        sessionId: session.session_id, sessionName: session.session_name, attachInfo,
      };
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to attach to session';
      setError(msg); toast.error(msg);
    }
    finally { setAttachingInProgress(false); }
  }, [wsService]);

  const handleSessionKilled = useCallback(() => {
    setSessionToKill(null);
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  const handleSessionCreated = useCallback(() => {
    setShowCreateModal(false);
    fetchSessions(selectedAgentId ?? undefined);
  }, [fetchSessions, selectedAgentId]);

  return {
    agents, sessions, loadingAgents, loadingSessions, error,
    selectedAgentId, filteredSessions, attachingInProgress,
    showCreateModal, sessionToKill,
    setSelectedAgentId, setShowCreateModal, setSessionToKill,
    handleAgentClick, handleAttach, handleSessionKilled, handleSessionCreated,
    fetchSessions,
  };
}
