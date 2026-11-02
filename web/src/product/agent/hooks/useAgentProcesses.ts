import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent } from '@/types';
import type { ProcessSnapshot } from '@/generated/protocol/core/server-session-processes/v1';
import { sessionsApi } from '@/product/session';

/**
 * Read-only process discovery for the Workspace's current Session (#2514).
 *
 * The Agent capability observes one Session — the one whose Workspace the user
 * is already in. It never lists the Agent's other Sessions and never silently
 * chooses one: with no current Session the view is explicitly empty.
 *
 * A failed refresh keeps the last snapshot and says it is stale rather than
 * blanking the view — "we could not ask" and "there is nothing" are different
 * answers.
 */
export interface AgentProcessesState {
  /** The current Session id, when the Workspace has one for this Agent. */
  sessionId: string | null;
  /** The current Session's name, derived from the id before a snapshot arrives. */
  sessionName: string | null;
  snapshot: ProcessSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  /** The snapshot is from an earlier successful read; the latest attempt failed. */
  snapshotStale: boolean;
  /** Ask the Agent again for the current Session. */
  refresh: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `agent_id:session_name` → `session_name`; a name may itself contain colons. */
function sessionNameOf(sessionId: string | null): string | null {
  if (!sessionId) {
    return null;
  }
  const separator = sessionId.indexOf(':');
  const name = separator >= 0 ? sessionId.slice(separator + 1) : sessionId;
  return name.length > 0 ? name : null;
}

function useConnectionRevision(): number {
  const [revision, setRevision] = useState(() => sessionsApi.connectionRevision());
  useEffect(
    () =>
      sessionsApi.onConnectionChange(() => {
        setRevision(sessionsApi.connectionRevision());
      }),
    [],
  );
  return revision;
}

function useSnapshot(
  agent: Agent,
  sessionId: string | null,
  connectionRevision: number,
) {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const snapshotRef = useRef<ProcessSnapshot | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    if (!sessionId) {
      snapshotRef.current = null;
      setSnapshot(null);
      setError(null);
      setStale(false);
      setLoading(false);
      return;
    }
    // A refresh of the same Session may keep the last snapshot while the new
    // read is in flight; a different Session never inherits it. Keeping it
    // would label another Session's processes as this one's.
    if (snapshotRef.current?.session_name !== sessionNameOf(sessionId)) {
      snapshotRef.current = null;
      setSnapshot(null);
      setStale(false);
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
      .fetchProcessSnapshot(sessionId)
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
  }, [sessionId, refreshNonce, agent.status, connectionRevision]);

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  return { snapshot, loading, error, stale, refresh };
}

export function useAgentProcesses(
  agent: Agent,
  currentSessionId?: string | null,
): AgentProcessesState {
  const connectionRevision = useConnectionRevision();
  const sessionId = currentSessionId ?? null;
  const snapshot = useSnapshot(agent, sessionId, connectionRevision);

  return {
    sessionId,
    sessionName: sessionNameOf(sessionId),
    snapshot: snapshot.snapshot,
    snapshotLoading: snapshot.loading,
    snapshotError: snapshot.error,
    snapshotStale: snapshot.stale,
    refresh: snapshot.refresh,
  };
}
