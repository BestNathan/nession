import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Agent } from '../types';
import type { WebSocketService } from '../services/websocket';

function trackHeartbeats(newAgents: Agent[], map: Map<string, string[]>) {
  for (const agent of newAgents) {
    if (!agent.last_heartbeat) { continue; }
    const history = map.get(agent.agent_id) ?? [];
    history.push(agent.last_heartbeat);
    if (history.length > 10) { history.splice(0, history.length - 10); }
    map.set(agent.agent_id, history);
  }
}

/** Agents data: state, fetch, heartbeat history tracking. */
export function useAgentData(wsService: WebSocketService) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
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

  const getHeartbeatHistory = useCallback((agentId: string): string[] => {
    return heartbeatHistory.current.get(agentId) ?? [];
  }, []);

  const applyAgentUpdate = useCallback((newAgents: Agent[]) => {
    setAgents(newAgents);
    trackHeartbeats(newAgents, heartbeatHistory.current);
  }, []);

  return {
    agents, setAgents,
    loadingAgents,
    error, setError,
    fetchAgents,
    getHeartbeatHistory,
    applyAgentUpdate,
  };
}
