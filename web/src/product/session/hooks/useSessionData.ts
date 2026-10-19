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

/**
 * A request reply with a real pane command can be observed by a raw socket
 * watcher without ever reaching the Session row: request-correlation consumes
 * the message before SessionsPlugin's listeners see it. If an intervening push
 * superseded that reply but lacks its command, we need another authoritative
 * list, not the stale reply itself. Never reconcile by copying non-null fields
 * from an out-of-order reply: newer events can intentionally clear them.
 */
function hasUnprojectedForegroundReport(reply: Session[], visible: Session[]): boolean {
  const byId = new Map(visible.map((session) => [session.session_id, session]));
  return reply.some((session) => {
    const reported = session.foreground_command;
    return Boolean(reported && byId.has(session.session_id)
      && byId.get(session.session_id)?.foreground_command !== reported);
  });
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
  // Synchronously tracks the last authoritative projection for network
  // callbacks, without depending on a React render completing in between.
  const visibleSessions = useRef<Session[]>([]);
  const applyRealtimeSessions = useCallback((incoming: Session[]) => {
    realtimeRevision.current += 1;
    visibleSessions.current = incoming;
    setSessions(incoming);
  }, []);

  const fetchSessions = useCallback(async (opts: FetchSessionsOptions = {}) => {
    const sequence = ++requestSequence.current;
    setLoadingSessions(true);
    try {
      // At most one reconciliation request. No loops tied to heartbeat rate
      // and no direct adoption of a response that a newer push superseded.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const revisionAtStart = realtimeRevision.current;
        try {
          const response = await sessionsApi.fetchSessions(opts);
          if (sequence !== requestSequence.current) {
            return; // A newer explicit refresh owns the answer.
          }
          if (revisionAtStart !== realtimeRevision.current) {
            // A correlated list reply may contain a report the newer push
            // omitted. Retry the authoritative list once, without accepting
            // possibly stale commands or overwriting the newer push (#1986).
            if (attempt === 0 && hasUnprojectedForegroundReport(
              response.sessions, visibleSessions.current,
            )) {
              continue;
            }
            return;
          }
          visibleSessions.current = response.sessions;
          setSessions(response.sessions);
          const stale = response.stale_agents ?? [];
          setStaleAgents(stale);
          if (stale.length > 0) {
            toast.warning(
              `${stale.length} agent(s) did not respond — their sessions may be out of date`,
            );
          }
          return;
        } catch (err) {
          if (sequence === requestSequence.current &&
              revisionAtStart === realtimeRevision.current) {
            const msg = err instanceof Error ? err.message : 'Failed to fetch sessions';
            toast.error(msg);
          }
          return;
        }
      }
    } finally {
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
    // A create ACK is newer than an outstanding list request too. It must not
    // be silently undone by a stale pre-create list response.
    realtimeRevision.current += 1;
    const prev = visibleSessions.current;
    if (!prev.some((existing) => existing.session_id === session.session_id)) {
      const next = [session, ...prev];
      visibleSessions.current = next;
      setSessions(next);
    }
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
