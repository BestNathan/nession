import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type { Session } from '../types';
import { sessionsApi } from '../features/sessions';

/** Options for {@link useSessionData}'s `fetchSessions`. */
export interface FetchSessionsOptions {
  agentId?: string;
  /** Ask the server to re-query every online agent for its live tmux state
   *  instead of answering from its own registry. */
  force?: boolean;
}

/** Sessions data: state, fetch, realtime apply. */
export function useSessionData() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  /** False until the first fetch attempt finishes (success or failure). */
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  /** Agents that failed to answer the last force refresh. Their sessions are
   *  still shown, flagged as possibly out of date. */
  const [staleAgents, setStaleAgents] = useState<string[]>([]);

  const fetchSessions = useCallback(async (opts: FetchSessionsOptions = {}) => {
    setLoadingSessions(true);
    try {
      const response = await sessionsApi.fetchSessions(opts);
      setSessions(response.sessions);
      const stale = response.stale_agents ?? [];
      setStaleAgents(stale);
      if (stale.length > 0) {
        toast.warning(
          `${stale.length} agent(s) did not respond — their sessions may be out of date`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
      toast.error(msg);
    } finally {
      setLoadingSessions(false);
      setSessionsLoaded(true);
    }
  }, []);

  return {
    sessions, setSessions,
    loadingSessions,
    sessionsLoaded,
    staleAgents,
    fetchSessions,
  };
}
