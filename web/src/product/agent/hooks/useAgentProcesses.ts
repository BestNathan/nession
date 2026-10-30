import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Session } from '@/types';
import type { ProcessSnapshot } from '@/generated/protocol/core/server-session-processes/v1';
import { sessionsApi } from '@/product/session';

/**
 * Read-only process discovery for one Agent's Sessions (#2514).
 *
 * Two independent reads, deliberately kept apart: the Session list comes from
 * the Server's registry, and each snapshot comes from the Agent on demand. A
 * failed refresh keeps the last snapshot and says it is stale rather than
 * blanking the view — "we could not ask" and "there is nothing" are different
 * answers.
 */
export interface AgentProcessesState {
  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  selectedSessionId: string | null;
  selectSession: (sessionId: string) => void;
  snapshot: ProcessSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  /** The snapshot is from an earlier successful read; the latest attempt failed. */
  snapshotStale: boolean;
  /** Ask the Agent again for the selected Session. */
  refresh: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useAgentSessions(agentId: string, currentSessionId?: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    request.current += 1;
    setSessions([]);
    setSelectedSessionId(null);
  }, [agentId]);

  useEffect(() => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    sessionsApi
      .listSessions(agentId)
      .then((list) => {
        if (current === request.current) {
          setSessions(list);
        }
      })
      .catch((failure: unknown) => {
        if (current === request.current) {
          setError(errorMessage(failure));
        }
      })
      .finally(() => {
        if (current === request.current) {
          setLoading(false);
        }
      });
  }, [agentId]);

  // Keep a valid selection as the list changes. Prefer the Session the
  // Workspace was opened from, so returning to this view keeps focus.
  useEffect(() => {
    if (loading) {
      return;
    }
    setSelectedSessionId((previous) => {
      if (previous && sessions.some((session) => session.session_id === previous)) {
        return previous;
      }
      const preferred =
        currentSessionId && sessions.some((session) => session.session_id === currentSessionId)
          ? currentSessionId
          : null;
      return preferred ?? sessions[0]?.session_id ?? null;
    });
  }, [sessions, loading, currentSessionId]);

  return { sessions, loading, error, selectedSessionId, setSelectedSessionId };
}

function useSnapshot(agent: Agent, selectedSessionId: string | null) {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const snapshotRef = useRef<ProcessSnapshot | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    if (!selectedSessionId) {
      snapshotRef.current = null;
      setSnapshot(null);
      setError(null);
      setStale(false);
      setLoading(false);
      return;
    }
    if (agent.status !== 'online') {
      // Do not pretend the Agent answered. A previous snapshot may still be
      // useful, but it is explicitly stale.
      setLoading(false);
      setError('Agent offline — no new process snapshot can be read');
      setStale(snapshotRef.current !== null);
      return;
    }

    setLoading(true);
    setError(null);
    sessionsApi
      .fetchProcessSnapshot(selectedSessionId)
      .then((next) => {
        if (current === request.current) {
          snapshotRef.current = next;
          setSnapshot(next);
          setStale(false);
        }
      })
      .catch((failure: unknown) => {
        if (current === request.current) {
          setError(errorMessage(failure));
          setStale(snapshotRef.current !== null);
        }
      })
      .finally(() => {
        if (current === request.current) {
          setLoading(false);
        }
      });
  }, [selectedSessionId, refreshNonce, agent.status]);

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  return { snapshot, loading, error, stale, refresh };
}

export function useAgentProcesses(
  agent: Agent,
  currentSessionId?: string | null,
): AgentProcessesState {
  const sessions = useAgentSessions(agent.agent_id, currentSessionId);
  const snapshot = useSnapshot(agent, sessions.selectedSessionId);

  return {
    sessions: sessions.sessions,
    sessionsLoading: sessions.loading,
    sessionsError: sessions.error,
    selectedSessionId: sessions.selectedSessionId,
    selectSession: sessions.setSelectedSessionId,
    snapshot: snapshot.snapshot,
    snapshotLoading: snapshot.loading,
    snapshotError: snapshot.error,
    snapshotStale: snapshot.stale,
    refresh: snapshot.refresh,
  };
}
