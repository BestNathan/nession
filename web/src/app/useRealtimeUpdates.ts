import { useEffect, useCallback } from 'react';
import type { WebSocketService } from '../platform/socket';
import { agentsApi } from '@/product/agent';
import { sessionsApi } from '@/product/session';
import type { useAgentData } from '@/product/agent/hooks/useAgentData';
import type { useSessionData } from '@/product/session/hooks/useSessionData';

type AgentDataReturn = ReturnType<typeof useAgentData>;
type SessionDataReturn = ReturnType<typeof useSessionData>;

/**
 * Bridges the agent/session data hooks to the realtime push channel.
 *
 * Subscriptions go through the typed feature APIs (agentsApi/sessionsApi) so
 * they see the same event set the legacy facade exposed — server pushes plus
 * the echo of own list responses. The effects are still keyed on the
 * wsService instance: a replaced transport re-installs the feature plugins
 * with a new generation, so consumers must re-register when it changes or
 * the plugin teardown drops their callbacks.
 *
 * This hook no longer performs the initial or post-reconnect fetch (#4602).
 * Each list's pull controller owns mount, activate, foreground, reconnect and
 * cadence reads, so a second fetch path here would double every resume and
 * race the controller's own fence. A push is handed to the same fence as a
 * pull, never applied around it.
 */
export function useRealtimeUpdates(
  wsService: WebSocketService,
  agentData: AgentDataReturn,
  sessionData: SessionDataReturn,
) {
  const { applyAgentUpdate } = agentData;
  const { applyRealtimeSessions, fetchSessions } = sessionData;

  useEffect(() => {
    const u1 = agentsApi.onAgentsChanged(applyAgentUpdate);
    const u2 = sessionsApi.onSessionsChanged(applyRealtimeSessions);
    return () => { u1(); u2(); };
  }, [wsService, applyAgentUpdate, applyRealtimeSessions]);

  const clearError = useCallback(() => agentData.setError(null), [agentData]);

  return { clearError, fetchSessions };
}