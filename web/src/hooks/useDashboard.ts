import { useCallback, useMemo } from 'react';
import type { Agent, Session } from '../types';
import type { WebSocketService } from '../services/socket';
import { useWebSocket } from './useWebSocket';
import { useAgentData } from './useAgentData';
import { useSessionData, type FetchSessionsOptions } from './useSessionData';
import { useDashboardFilter, type StatusFilter, type SortField, type SortDirection } from './useDashboardFilter';
import { useDashboardModals } from './useDashboardModals';
import { useRealtimeUpdates } from './useRealtimeUpdates';

export type { StatusFilter, SortField, SortDirection };

export interface DashboardState {
  agents: Agent[];
  sessions: Session[];
  loadingAgents: boolean;
  loadingSessions: boolean;
  sessionsLoaded: boolean;
  error: string | null;
  selectedAgent: Agent | null;
  filteredAgents: Agent[];
  filteredSessions: Session[];
  showCreateModal: boolean;
  sessionToKill: Session | null;
  previewSession: Session | null;
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
  setPreviewSession: (s: Session | null) => void;
  handleSessionKilled: () => void;
  handleSessionCreated: () => void;
  fetchSessions: (opts?: FetchSessionsOptions) => Promise<void>;
  /** Agents that failed to answer the last force refresh. */
  staleAgents: string[];
  getHeartbeatHistory: (agentId: string) => string[];
  updateAgent: (updated: Agent) => void;
  clearError: () => void;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function filterAgents(agents: Agent[], statusFilter: StatusFilter, searchQuery: string): Agent[] {
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

interface FilterSessionsOpts {
  statusFilter: StatusFilter;
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
}

function filterSessions(
  sessions: Session[],
  agents: Agent[],
  opts: FilterSessionsOpts,
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

// ── Composed hook ────────────────────────────────────────────────────────

/**
 * Composes agent/session data, filter state, modal state, and realtime
 * subscriptions into the single shape that `<Dashboard>` consumes.
 */
export function useDashboard(wsService?: WebSocketService): DashboardState {
  const service = useWebSocket(wsService);

  // Data
  const agentData = useAgentData();
  const sessionData = useSessionData();

  // Realtime subscriptions + initial fetch (service instance keys the
  // re-registration when a reconnect replaces the transport)
  const { clearError, fetchSessions } = useRealtimeUpdates(service, agentData, sessionData);

  // Filter state
  const {
    searchQuery, setSearchQuery,
    statusFilter, setStatusFilter,
    sortField, sortDirection, toggleSort,
    isSearchActive,
  } = useDashboardFilter();

  // Modal state
  const {
    selectedAgent, setSelectedAgent,
    showCreateModal, setShowCreateModal,
    sessionToKill, setSessionToKill,
    previewSession, setPreviewSession,
  } = useDashboardModals();

  // Derived filtered lists (memoised on data + filter state)
  const filteredAgents = useMemo(
    () => filterAgents(agentData.agents, statusFilter, searchQuery),
    [agentData.agents, statusFilter, searchQuery],
  );
  const filteredSessions = useMemo(
    () => filterSessions(
      sessionData.sessions, agentData.agents,
      { statusFilter, searchQuery, sortField, sortDirection },
    ),
    [sessionData.sessions, agentData.agents, statusFilter, searchQuery, sortField, sortDirection],
  );

  // Handlers
  const handleSessionKilled = useCallback(() => {
    setSessionToKill(null);
    fetchSessions();
  }, [fetchSessions, setSessionToKill]);

  const handleSessionCreated = useCallback(() => {
    setShowCreateModal(false);
    fetchSessions();
    agentData.fetchAgents();
  }, [fetchSessions, agentData, setShowCreateModal]);

  return {
    agents: agentData.agents,
    sessions: sessionData.sessions,
    loadingAgents: agentData.loadingAgents,
    loadingSessions: sessionData.loadingSessions,
    sessionsLoaded: sessionData.sessionsLoaded,
    error: agentData.error,
    selectedAgent,
    filteredAgents,
    filteredSessions,
    showCreateModal,
    sessionToKill,
    previewSession,
    searchQuery,
    statusFilter,
    sortField,
    sortDirection,
    isSearchActive,
    setSearchQuery,
    setStatusFilter,
    setSelectedAgent,
    toggleSort,
    setShowCreateModal,
    setSessionToKill,
    setPreviewSession,
    handleSessionKilled,
    handleSessionCreated,
    fetchSessions,
    staleAgents: sessionData.staleAgents,
    getHeartbeatHistory: agentData.getHeartbeatHistory,
    updateAgent: agentData.updateAgent,
    clearError,
  };
}
