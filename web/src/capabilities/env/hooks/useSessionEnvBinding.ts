import { useCallback, useEffect, useRef, useState } from 'react';
import { envApi } from '@/capabilities/env';
import type { SessionEnvBindingState } from '@/capabilities/env/types';

export interface SessionEnvBinding {
  /** Desired + observed state for the current Session; null when none exists. */
  binding: SessionEnvBindingState | null;
  loading: boolean;
  /** Why the observed half could not be read. Desired state may still exist. */
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The current Session's Environment Binding state (#170).
 *
 * The Environment workspace already asks `server.session.env.active` which
 * profiles are sourced; that answer says nothing about whether the Agent
 * materialized them or whether the running shell converged. This hook reads
 * the desired + observed binding so the page can state both.
 *
 * A stale response for a previous Session is dropped rather than rendered
 * under the new Session's name.
 */
export function useSessionEnvBinding(sessionId: string | null): SessionEnvBinding {
  const [binding, setBinding] = useState<SessionEnvBindingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = request.current + 1;
    request.current = id;
    if (!sessionId) {
      setBinding(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const resp = await envApi.getSessionEnvBinding(sessionId);
      if (request.current !== id) {
        return;
      }
      if (!resp.success) {
        setBinding(null);
        setError(resp.error ?? 'Environment status unavailable');
      } else {
        setBinding(resp.binding ?? null);
        setError(resp.error ?? null);
      }
    } catch (e) {
      if (request.current !== id) {
        return;
      }
      setBinding(null);
      setError(e instanceof Error ? e.message : 'Environment status unavailable');
    } finally {
      if (request.current === id) {
        setLoading(false);
      }
    }
  }, [sessionId]);

  // A Session switch must not keep showing the previous Session's status
  // while the new read is in flight.
  useEffect(() => {
    setBinding(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { binding, loading, error, refresh };
}
