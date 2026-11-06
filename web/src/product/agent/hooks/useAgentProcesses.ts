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

/**
 * Everything a read produced, bound to the full Session identity that asked.
 *
 * Session identity is `agent_id:session_name`, not the display name: two Agents
 * can each have a Session called `dev`, and one of them must never answer for
 * the other. Binding the whole result — not only the snapshot — is what lets a
 * render expose `null` for a previous identity before any effect has run.
 */
interface BoundSnapshot {
  sessionId: string;
  snapshot: ProcessSnapshot | null;
  error: string | null;
  stale: boolean;
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
  const [result, setResult] = useState<BoundSnapshot | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const resultRef = useRef<BoundSnapshot | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    if (!sessionId) {
      resultRef.current = null;
      setResult(null);
      setLoadingSessionId(null);
      return;
    }
    // A refresh of the same full Session may keep the last snapshot while the
    // new read is in flight; a different Session never inherits it. The full
    // id is the identity — `agent-a:dev` and `agent-b:dev` are different
    // Sessions that happen to share a name.
    const retained = resultRef.current?.sessionId === sessionId ? resultRef.current : null;
    if (!retained) {
      resultRef.current = null;
      setResult(null);
    }
    if (agent.status !== 'online') {
      // Do not pretend the Agent answered. Only this Session's own previous
      // snapshot may still be useful, and it is explicitly stale.
      const next: BoundSnapshot = {
        sessionId,
        snapshot: retained?.snapshot ?? null,
        error: 'Agent offline — no new process snapshot can be read',
        stale: retained !== null && retained.snapshot !== null,
      };
      resultRef.current = next;
      setLoadingSessionId(null);
      setResult(next);
      return;
    }

    if (retained) {
      // Keep the last-known snapshot visible while the refresh is in flight,
      // without carrying a previous attempt's error into it.
      const next: BoundSnapshot = { ...retained, error: null };
      resultRef.current = next;
      setResult(next);
    }
    setLoadingSessionId(sessionId);
    sessionsApi
      .fetchProcessSnapshot(sessionId)
      .then((next) => {
        if (current === request.current) {
          const bound: BoundSnapshot = {
            sessionId,
            snapshot: next,
            error: null,
            stale: false,
          };
          resultRef.current = bound;
          setResult(bound);
        }
      })
      .catch((failure: unknown) => {
        if (current === request.current) {
          const bound: BoundSnapshot = {
            sessionId,
            snapshot: retained?.snapshot ?? null,
            error: errorMessage(failure),
            stale: retained !== null && retained.snapshot !== null,
          };
          resultRef.current = bound;
          setResult(bound);
        }
      })
      .finally(() => {
        if (current === request.current) {
          setLoadingSessionId(null);
        }
      });
  }, [sessionId, refreshNonce, agent.status, connectionRevision]);

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  // Expose a read only for the identity that asked for it. Deriving here, in
  // render, closes the interval between the visible Session change and the
  // effect above: no frame can label one Session's data as another's.
  const bound = result !== null && result.sessionId === sessionId ? result : null;

  return {
    snapshot: bound?.snapshot ?? null,
    loading: sessionId !== null && loadingSessionId === sessionId,
    error: bound?.error ?? null,
    stale: bound?.stale ?? false,
    refresh,
  };
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
