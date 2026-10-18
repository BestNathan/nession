import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { Session } from '@/types';
import { sessionsApi } from '@/product/session';

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

  // #1900: an already-in-flight server.session.list response can describe an
  // older registry snapshot than an intervening server.sessions.changed push.
  // "last promise to resolve wins" was replacing the real foreground command
  // with the old unknown value and made session-lifecycle flaky. Fence old
  // request results by the local event order instead of guessing that a
  // non-null foreground_command must win (a later push can legitimately clear
  // it). A newer refresh also supersedes an older refresh.
  const realtimeRevision = useRef(0);
  const requestSequence = useRef(0);
  const applyRealtimeSessions = useCallback((incoming: Session[]) => {
    realtimeRevision.current += 1;
    setSessions(incoming);
  }, []);

  const fetchSessions = useCallback(async (opts: FetchSessionsOptions = {}) => {
    const sequence = ++requestSequence.current;
    const revisionAtStart = realtimeRevision.current;
    setLoadingSessions(true);
    try {
      const response = await sessionsApi.fetchSessions(opts);
      // The response is older than a push received after the request started,
      // or than a later refresh. Do not replace that newer session snapshot,
      // nor overwrite its stale-agent metadata with an obsolete response.
      if (sequence !== requestSequence.current ||
          revisionAtStart !== realtimeRevision.current) {
        return;
      }
      setSessions(response.sessions);
      const stale = response.stale_agents ?? [];
      setStaleAgents(stale);
      if (stale.length > 0) {
        toast.warning(
          `${stale.length} agent(s) did not respond — their sessions may be out of date`,
        );
      }
    } catch (err) {
      if (sequence === requestSequence.current &&
          revisionAtStart === realtimeRevision.current) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
        toast.error(msg);
      }
    } finally {
      // An obsolete request cannot reset the loading indicator for a newer
      // in-flight refresh. A completed latest request still settles loading
      // even when an intervening realtime push superseded its response.
      if (sequence === requestSequence.current) {
        setLoadingSessions(false);
        setSessionsLoaded(true);
      }
    }
  }, []);

  /**
   * Insert a Session the client already knows the identity of, before any list
   * carries it (#1430). The create ACK is the one caller today: its id is
   * authoritative, and `sessionFromCreateAck` mirrors the row the server has
   * already committed, so the insert is not a guess — it is the same row one
   * projection earlier.
   *
   * Idempotent by id: if the list already carries it (the broadcast raced
   * ahead), the existing row wins and nothing is overwritten.
   */
  const insertSession = useCallback((session: Session) => {
    setSessions((prev) =>
      prev.some((existing) => existing.session_id === session.session_id)
        ? prev
        : [session, ...prev],
    );
  }, []);

  return {
    sessions, setSessions,
    applyRealtimeSessions,
    insertSession,
    loadingSessions,
    sessionsLoaded,
    staleAgents,
    fetchSessions,
  };
}
