import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Agent } from '../types';
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

/** Shallow-compare two agent lists by meaningful fields.
 *  Returns true when every agent matches on the fields the UI renders —
 *  last_heartbeat is intentionally excluded because it changes every 10s
 *  and would defeat deduplication. */
function agentsEqual(a: Agent[], b: Agent[]): boolean {
  if (a.length !== b.length) { return false; }
  const key = (agent: Agent) =>
    `${agent.agent_id}|${agent.status}|${agent.session_count}|${agent.active_sessions ?? 0}|${agent.display_name ?? ''}`;
  return a.every((agent, i) => key(agent) === key(b[i]));
}

/** Agents data: state, fetch, heartbeat history tracking. */
export function useAgentData(wsService: WebSocketService) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heartbeatHistory = useRef<Map<string, string[]>>(new Map());
  const wsServiceRef = useRef(wsService);
  wsServiceRef.current = wsService;

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    setError(null);
    try {
      const newAgents = await wsServiceRef.current.listAgents();
      setAgents(newAgents);
      trackHeartbeats(newAgents, heartbeatHistory.current);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch agents';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const getHeartbeatHistory = useCallback((agentId: string): string[] => {
    return heartbeatHistory.current.get(agentId) ?? [];
  }, []);

  const applyAgentUpdate = useCallback((newAgents: Agent[]) => {
    trackHeartbeats(newAgents, heartbeatHistory.current);
    setAgents((prev) => {
      if (agentsEqual(prev, newAgents)) {
        return prev; // React bails out of re-render when reference is unchanged
      }
      return newAgents;
    });
  }, []);

  /** Replace a single agent in the list (used after rename). */
  const updateAgent = useCallback((updated: Agent) => {
    setAgents((prev) => prev.map((a) => (a.agent_id === updated.agent_id ? updated : a)));
  }, []);

  return {
    agents, setAgents,
    loadingAgents,
    error, setError,
    fetchAgents,
    getHeartbeatHistory,
    applyAgentUpdate,
    updateAgent,
  };
}
