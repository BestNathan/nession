import { useEffect, useCallback } from 'react';
import type { WebSocketService } from '../services/socket';
import { agentsApi } from '../features/agents';
import { sessionsApi } from '../features/sessions';
import type { useAgentData } from './useAgentData';
import type { useSessionData } from './useSessionData';

type AgentDataReturn = ReturnType<typeof useAgentData>;
type SessionDataReturn = ReturnType<typeof useSessionData>;

/**
 * Subscribes to live agent/session events and performs the initial data
 * fetch. Bridges the agent/session data hooks to the realtime push channel.
 *
 * Subscriptions go through the typed feature APIs (agentsApi/sessionsApi) so
 * they see the same event set the legacy facade exposed — server pushes plus
 * the echo of own list responses. The effects are still keyed on the
 * wsService instance: a replaced transport re-installs the feature plugins
 * with a new generation, so consumers must re-register when it changes or
 * the plugin teardown drops their callbacks.
 */
export function useRealtimeUpdates(
  wsService: WebSocketService,
  agentData: AgentDataReturn,
  sessionData: SessionDataReturn,
) {
  const { fetchAgents, applyAgentUpdate } = agentData;
  const { setSessions, fetchSessions } = sessionData;

  useEffect(() => {
    const u1 = agentsApi.onAgentsChanged(applyAgentUpdate);
    const u2 = sessionsApi.onSessionsChanged(setSessions);
    return () => { u1(); u2(); };
  }, [wsService, applyAgentUpdate, setSessions]);

  useEffect(() => {
    const fetchIfConnected = () => {
      if (wsService.connectionState !== 'connected') {
        return;
      }
      fetchAgents();
      fetchSessions();
    };

    // 'connected' on the transport IS the post-handshake state (there is no
    // separate 'authenticated' anymore).
    fetchIfConnected();
    return wsService.onConnectionStateChange((state) => {
      if (state === 'connected') {
        fetchIfConnected();
      }
    });
  }, [wsService, fetchAgents, fetchSessions]);

  const clearError = useCallback(() => agentData.setError(null), [agentData]);

  return { clearError, fetchSessions };
}
