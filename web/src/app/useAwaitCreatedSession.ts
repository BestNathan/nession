import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@/types';

/** Select a session once it appears in the refreshed list (e.g. after create). */
export function useAwaitCreatedSession(
  sessions: Session[],
  onSelect: (session: Session) => void,
) {
  const [awaitingSessionId, setAwaitingSessionId] = useState<string | null>(null);

  const awaitSession = useCallback((sessionId: string | undefined) => {
    setAwaitingSessionId(sessionId ?? null);
  }, []);

  useEffect(() => {
    if (awaitingSessionId === null) {
      return;
    }
    const created = sessions.find((s) => s.session_id === awaitingSessionId);
    if (!created) {
      return;
    }
    setAwaitingSessionId(null);
    onSelect(created);
  }, [awaitingSessionId, sessions, onSelect]);

  return { awaitSession };
}
