import { useState, useCallback } from 'react';
import { toast } from 'sonner';
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      toast.error(msg);
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
