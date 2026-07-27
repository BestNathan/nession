import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Agent, Session } from '../types';
import type { WebSocketService } from '../services/websocket';

function trackHeartbeats(newAgents: Agent[], map: Map<string, string[]>) {
  for (const agent of newAgents) {
    if (!agent.last_heartbeat) { continue; }
    const history = map.get(agent.agent_id) ?? [];
    history.push(agent.last_heartbeat);
    if (history.length > 5) { history.splice(0, history.length - 5); }
    map.set(agent.agent_id, history);
  }
}

/** Agents + sessions data: state, fetch, heartbeat history tracking. */
export function useDashboardData(wsService: WebSocketService) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heartbeatHistory = useRef<Map<string, string[]>>(new Map());

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try {
      const newAgents = await wsService.listAgents();
      setAgents(newAgents);
      trackHeartbeats(newAgents, heartbeatHistory.current);
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
      const newSessions = await wsService.listSessions(agentId);
      setSessions(newSessions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoadingSessions(false);
    }
  }, [wsService]);

  const getHeartbeatHistory = useCallback((agentId: string): string[] => {
    return heartbeatHistory.current.get(agentId) ?? [];
  }, []);

  const applyAgentUpdate = useCallback((newAgents: Agent[]) => {
    setAgents(newAgents);
    trackHeartbeats(newAgents, heartbeatHistory.current);
  }, []);

  const updateAgent = useCallback((updated: Agent) => {
    setAgents((prev) => prev.map((a) => (a.agent_id === updated.agent_id ? updated : a)));
  }, []);

  return {
    agents, setAgents,
    sessions, setSessions,
    loadingAgents,
    loadingSessions,
    error, setError,
    fetchAgents,
    fetchSessions,
    getHeartbeatHistory,
    applyAgentUpdate,
    updateAgent,
  };
}
