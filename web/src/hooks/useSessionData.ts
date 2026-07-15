import { useState, useCallback } from 'react';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';

/** Sessions data: state, fetch, realtime apply. */
export function useSessionData(wsService: WebSocketService) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const fetchSessions = useCallback(async (agentId?: string) => {
    setLoadingSessions(true);
    try {
      setSessions(await wsService.listSessions(agentId));
    } catch {
      // Error surfaced via toast in the service layer; UI will re-fetch on next event.
    } finally {
      setLoadingSessions(false);
    }
  }, [wsService]);

  return {
    sessions, setSessions,
    loadingSessions,
    fetchSessions,
  };
}
