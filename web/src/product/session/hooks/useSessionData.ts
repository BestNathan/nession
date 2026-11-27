import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Session } from '@/types';
import type { SessionsListResponse } from '@/product/session/types';
import { sessionsApi } from '@/product/session';
import { observeSessionIncarnations } from '@/product/session/state/metadata';
import { usePullRefresh, type PullContext, type PullRefreshPolicy } from '@/platform/refresh';

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

/** Session cadence from #4602 §2. The ordinary read is *not* a force read:
 *  force re-enumerates every online Agent and is reserved for an explicit user
 *  refresh, so a periodic poll never fans out across the fleet. */
const SESSION_LIST_POLICY: PullRefreshPolicy = {
  intervalMs: 12_000,
  minIntervalMs: 2_000,
  timeoutMs: 20_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

export interface SessionDataOptions {
  connectionRevision?: number;
  enabled?: boolean;
  active?: boolean;
}

/**
 * Sessions data: state, fetch, realtime apply.
 *
 * The list, its incarnation observation and its `stale_agents` semantics stay
 * here. The shared pull controller (#4602) owns when a read happens, the
 * one-in-flight/one-intent budget, and the fence that stops an older reply from
 * replacing a newer push — the hazard the previous hand-written
 * `requestSequence`/`realtimeRevision` pair guarded (#1900).
 *
 * The domain-specific half of that guard is preserved: a fenced-out reply which
 * carried the only report of a pane's foreground command owes exactly one
 * reconciliation read (#1986), capped so continual pushes cannot spin.
 */
export function useSessionData(options: SessionDataOptions = {}) {
  const { connectionRevision = 0, enabled = true, active = true } = options;
  const [sessions, setSessions] = useState<Session[]>([]);
  /** False until the first fetch attempt finishes (success or failure). */
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  /** Agents that failed to answer the last force refresh. Their sessions are
   *  still shown, flagged as possibly out of date. */
  const [staleAgents, setStaleAgents] = useState<string[]>([]);
  const [scopeAgentId, setScopeAgentId] = useState<string | undefined>(undefined);
  /** Synchronously tracks the last authoritative projection for network
   *  callbacks, without depending on a React render completing in between. */
  const visibleSessions = useRef<Session[]>([]);
  const scopeRef = useRef<string | undefined>(undefined);
  const lastReason = useRef<PullContext['reason']>('mount');
  const lastStaleSignature = useRef('');
  const errorRef = useRef<string | null>(null);
  /** One reconciliation read per settled read projection, not per push
   *  (#1986). A push is authoritative but is not a read landing, so it must
   *  not refresh the budget — otherwise continual pushes would spin. */
  const reconciled = useRef(false);
  const applyingPush = useRef(false);

  const apply = useCallback((response: SessionsListResponse) => {
    // A correlated list reply is authoritative in the same way a push is:
    // invalidate a name-keyed metadata entry when the instance changed (#3424).
    observeSessionIncarnations(response.sessions);
    visibleSessions.current = response.sessions;
    if (!applyingPush.current) { reconciled.current = false; }
    setSessions(response.sessions);
    setSessionsLoaded(true);
    const stale = response.stale_agents ?? [];
    setStaleAgents(stale);
    // A partial answer is surfaced, not hidden. Only a changed stale set or an
    // explicit user refresh speaks: a 12s poll must not raise a toast storm.
    const signature = stale.join(',');
    if (stale.length > 0
      && (lastReason.current === 'manual' || signature !== lastStaleSignature.current)) {
      toast.warning(
        `${stale.length} agent(s) did not respond — their sessions may be out of date`,
      );
    }
    lastStaleSignature.current = signature;
  }, []);

  const pull = useCallback(async (ctx: PullContext) => {
    lastReason.current = ctx.reason;
    const opts: { agentId?: string; force?: boolean } = {};
    if (scopeRef.current) { opts.agentId = scopeRef.current; }
    if (ctx.force) { opts.force = true; }
    try {
      return await sessionsApi.fetchSessions(opts);
    } catch (error) {
      // Record synchronously: an explicit caller reports the real failure in
      // the same tick, without waiting for a status render to catch up.
      errorRef.current = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }, []);

  const invalidateRef = useRef<(reason?: 'invalidate') => void>(() => {});

  const {
    refresh, invalidate, acceptExternal, status,
  } = usePullRefresh<SessionsListResponse>({
    context: ['session-list', connectionRevision, scopeAgentId ?? null],
    active,
    enabled,
    pull,
    apply,
    isPartial: (response) => (response.stale_agents?.length ?? 0) > 0,
    onSuperseded: (response) => {
      // The push stands; only a command the push never carried is worth another
      // read, and only once until a projection actually lands.
      if (!reconciled.current
        && hasUnprojectedForegroundReport(response.sessions, visibleSessions.current)) {
        reconciled.current = true;
        invalidateRef.current('invalidate');
      }
    },
    policy: SESSION_LIST_POLICY,
    label: 'session-list',
  });

  invalidateRef.current = invalidate;
  errorRef.current = status.error;

  const applyRealtimeSessions = useCallback((incoming: Session[]) => {
    // A push is an authoritative list: the same public id may now name a new
    // tmux incarnation. Tell the metadata owner before any row renders it
    // (#3424).
    observeSessionIncarnations(incoming);
    applyingPush.current = true;
    acceptExternal({ sessions: incoming, stale_agents: [] });
    applyingPush.current = false;
    visibleSessions.current = incoming;
    setSessionsLoaded(true);
  }, [acceptExternal]);

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
    const prev = visibleSessions.current;
    if (prev.some((existing) => existing.session_id === session.session_id)) { return; }
    // A create ACK is newer than an outstanding list request too. It must not
    // be silently undone by a stale pre-create list response.
    const next = [session, ...prev];
    observeSessionIncarnations(next);
    applyingPush.current = true;
    acceptExternal({ sessions: next, stale_agents: [] });
    applyingPush.current = false;
    visibleSessions.current = next;
  }, [acceptExternal]);

  /** Targeted re-read after a mutation, or an explicit force refresh. */
  const fetchSessions = useCallback(async (opts: FetchSessionsOptions = {}): Promise<void> => {
    scopeRef.current = opts.agentId;
    setScopeAgentId(opts.agentId);
    const outcome = await refresh(opts.force ? 'manual' : 'mutation');
    if (outcome === 'failed') {
      toast.error(errorRef.current ?? 'Failed to fetch sessions');
    }
  }, [refresh]);

  /** Explicit user refresh: always a force read of the current scope. */
  const refreshSessions = useCallback(() => refresh('manual'), [refresh]);

  return {
    sessions, setSessions,
    applyRealtimeSessions,
    insertSession,
    loadingSessions: status.loading,
    refreshingSessions: status.refreshing,
    sessionsStale: status.stale,
    sessionsLoaded,
    staleAgents,
    fetchSessions,
    refreshSessions,
    sessionError: status.error,
  };
}