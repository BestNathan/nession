import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { Session } from '../types';
import { sessionsApi } from '../features/sessions';
import type { WebSocketService } from '../services/socket';

export function useTerminalSessions(wsService: WebSocketService | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    if (!wsService) { return; }
    setLoading(true);
    setError(null);
    try {
      const list = await sessionsApi.listSessions();
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
    const unsub = sessionsApi.onSessionsChanged(setSessions);
    return () => { unsub(); };
  }, [wsService, fetchSessions]);

  return { sessions, loading, error, refetch: fetchSessions };
}
