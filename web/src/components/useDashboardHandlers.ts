import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import type { Agent, Session, AttachInfo } from '../types';
import type { WebSocketService } from '../services/websocket';
import type { AttachedSession } from './TerminalView';

export type StatusFilter = 'all' | 'online' | 'offline';
export type SortField = 'name' | 'activity';
export type SortDirection = 'asc' | 'desc';

export interface DashboardState {
  agents: Agent[];
  sessions: Session[];
  loadingAgents: boolean;
  loadingSessions: boolean;
  error: string | null;
  selectedAgent: Agent | null;
  filteredAgents: Agent[];
  filteredSessions: Session[];
  attachingInProgress: boolean;
  showCreateModal: boolean;
  sessionToKill: Session | null;
  searchQuery: string;
  statusFilter: StatusFilter;
  sortField: SortField;
  sortDirection: SortDirection;
  isSearchActive: boolean;
  setSearchQuery: (q: string) => void;
  setStatusFilter: (f: StatusFilter) => void;
  setSelectedAgent: (a: Agent | null) => void;
  toggleSort: (field: SortField) => void;
  setShowCreateModal: (show: boolean) => void;
  setSessionToKill: (s: Session | null) => void;
  handleAttach: (session: Session) => void;
  handleSessionKilled: () => void;
  handleSessionCreated: () => void;
  fetchSessions: (agentId?: string) => Promise<void>;
  getHeartbeatHistory: (agentId: string) => string[];
}

// ── Pure helpers (extracted to keep hook under 120-line lint limit) ──────

function trackHeartbeats(newAgents: Agent[], map: Map<string, string[]>) {
  for (const agent of newAgents) {
    if (!agent.last_heartbeat) { continue; }
    const history = map.get(agent.agent_id) ?? [];
    history.push(agent.last_heartbeat);
    if (history.length > 10) { history.splice(0, history.length - 10); }
    map.set(agent.agent_id, history);
  }
}

interface FilterSortOptions {
  statusFilter: StatusFilter;
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
}

function computeFilteredAgents(
  agents: Agent[],
  statusFilter: StatusFilter,
  searchQuery: string,
): Agent[] {
  let result = agents;
  if (statusFilter !== 'all') {
    result = result.filter((a) => a.status === statusFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(
      (a) => a.hostname.toLowerCase().includes(q) || a.agent_id.toLowerCase().includes(q),
    );
  }
  return result;
}

function computeFilteredSessions(
  sessions: Session[],
  agents: Agent[],
  opts: FilterSortOptions,
): Session[] {
  let result = sessions;
  if (opts.statusFilter !== 'all') {
    const ids = new Set(
      agents.filter((a) => a.status === opts.statusFilter).map((a) => a.agent_id),
    );
    result = result.filter((s) => ids.has(s.agent_id));
  }
  if (opts.searchQuery) {
    const q = opts.searchQuery.toLowerCase();
    result = result.filter(
      (s) => s.session_name.toLowerCase().includes(q) || s.agent_id.toLowerCase().includes(q),
    );
  }
  return [...result].sort((a, b) => {
    const cmp = opts.sortField === 'name'
      ? a.session_name.localeCompare(b.session_name)
      : a.last_activity.localeCompare(b.last_activity);
    return opts.sortDirection === 'asc' ? cmp : -cmp;
  });
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useDashboardHandlers(wsService: WebSocketService): DashboardState {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [attachingInProgress, setAttachingInProgress] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const heartbeatHistory = useRef<Map<string, string[]>>(new Map());

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try {
      const newAgents = await wsService.listAgents();
      setAgents(newAgents);
      trackHeartbeats(newAgents, heartbeatHistory.current);
    }
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
    const u1 = wsService.onAgentsChanged((newAgents) => {
      setAgents(newAgents);
      trackHeartbeats(newAgents, heartbeatHistory.current);
    });
    const u2 = wsService.onSessionsChanged(setSessions);
    return () => { u1(); u2(); };
  }, [wsService]);

  useEffect(() => { fetchAgents(); fetchSessions(); }, [fetchAgents, fetchSessions]);

  const getHeartbeatHistory = useCallback((agentId: string): string[] => {
    return heartbeatHistory.current.get(agentId) ?? [];
  }, []);

  const toggleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  const filteredAgents = useMemo(
    () => computeFilteredAgents(agents, statusFilter, searchQuery),
    [agents, statusFilter, searchQuery],
  );

  const filteredSessions = useMemo(
    () => computeFilteredSessions(sessions, agents, { statusFilter, searchQuery, sortField, sortDirection }),
    [sessions, agents, statusFilter, searchQuery, sortField, sortDirection],
  );

  const isSearchActive = searchQuery !== '' || statusFilter !== 'all';

  const handleAttach = useCallback(async (session: Session) => {
    setAttachingInProgress(true);
    setError(null);
    try {
      let attachInfo: AttachInfo;
      try { attachInfo = await wsService.requestAttach(session.session_id, 'p2p'); }
      catch { attachInfo = await wsService.requestAttach(session.session_id, 'relay'); }
      (handleAttach as unknown as { _attached?: AttachedSession })._attached = {
        sessionId: session.session_id, sessionName: session.session_name, attachInfo,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to attach to session';
      setError(msg); toast.error(msg);
    } finally { setAttachingInProgress(false); }
  }, [wsService]);

  const handleSessionKilled = useCallback(() => {
    setSessionToKill(null);
    fetchSessions();
  }, [fetchSessions]);

  const handleSessionCreated = useCallback(() => {
    setShowCreateModal(false);
    fetchSessions();
  }, [fetchSessions]);

  return {
    agents, sessions, loadingAgents, loadingSessions, error,
    selectedAgent, filteredAgents, filteredSessions, attachingInProgress,
    showCreateModal, sessionToKill,
    searchQuery, statusFilter, sortField, sortDirection, isSearchActive,
    setSearchQuery, setStatusFilter, setSelectedAgent, toggleSort,
    setShowCreateModal, setSessionToKill,
    handleAttach, handleSessionKilled, handleSessionCreated,
    fetchSessions, getHeartbeatHistory,
  };
}
