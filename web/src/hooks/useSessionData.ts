import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';

/** Sessions data: state, fetch, realtime apply. */
export function useSessionData(wsService: WebSocketService) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const wsServiceRef = useRef(wsService);
  wsServiceRef.current = wsService;

  const fetchSessions = useCallback(async (agentId?: string) => {
    setLoadingSessions(true);
    try {
      const newSessions = await wsServiceRef.current.listSessions(agentId);
      setSessions(newSessions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      toast.error(msg);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  return {
    sessions, setSessions,
    loadingSessions,
    fetchSessions,
  };
}
