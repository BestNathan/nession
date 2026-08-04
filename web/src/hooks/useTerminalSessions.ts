import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Session } from '../types';
import type { WebSocketService } from '../services/websocket';

export function useTerminalSessions(wsService: WebSocketService | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef(wsService);
  wsRef.current = wsService;

  const fetchSessions = useCallback(async () => {
    if (!wsService) { return; }
    setLoading(true);
    setError(null);
    try {
      const list = await wsService.listSessions();
      setSessions(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [wsService]);

  useEffect(() => {
    if (!wsService) { return; }
    fetchSessions();
    const unsub = wsService.onSessionsChanged(setSessions);
    return () => { unsub(); };
  }, [wsService, fetchSessions]);

  return { sessions, loading, error, refetch: fetchSessions };
}
