import { useEffect, useCallback } from 'react';
import type { WebSocketService } from '../services/websocket';
import type { useAgentData } from './useAgentData';
import type { useSessionData } from './useSessionData';

type AgentDataReturn = ReturnType<typeof useAgentData>;
type SessionDataReturn = ReturnType<typeof useSessionData>;

/**
 * Subscribes to live WebSocket events and performs the initial data fetch.
 * Bridges the agent/session data hooks to the realtime push channel.
 */
export function useRealtimeUpdates(
  wsService: WebSocketService,
  agentData: AgentDataReturn,
  sessionData: SessionDataReturn,
) {
  const { fetchAgents, applyAgentUpdate } = agentData;
  const { setSessions, fetchSessions } = sessionData;

  useEffect(() => {
    const u1 = wsService.onAgentsChanged(applyAgentUpdate);
    const u2 = wsService.onSessionsChanged(setSessions);
    return () => { u1(); u2(); };
  }, [wsService, applyAgentUpdate, setSessions]);

  useEffect(() => {
    fetchAgents();
    fetchSessions();
  }, [fetchAgents, fetchSessions]);

  const clearError = useCallback(() => agentData.setError(null), [agentData]);

  return { clearError, fetchSessions };
}
