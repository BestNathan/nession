import { useCallback, useEffect, useRef, useState } from 'react';
import { envApi } from '@/capabilities/env';
import type { EnvFileRef } from '@/types';
import type {
  SessionEnvBindingResponse,
  SessionEnvBindingState,
} from '@/capabilities/env/types';

export interface SessionEnvBinding {
  /** Desired + observed state for the current Session; null when none exists. */
  binding: SessionEnvBindingState | null;
  loading: boolean;
  /** Why the observed half could not be read. Desired state may still exist. */
  error: string | null;
  /** A replace/reapply is in flight. */
  pending: boolean;
  refresh: () => Promise<void>;
  /**
   * Replace the whole ordered binding. This is one request; callers must not
   * compose the selection from per-profile apply/unset calls.
   */
  replace: (refs: EnvFileRef[]) => Promise<SessionEnvBindingResponse>;
  /** Re-resolve the desired profiles at a new revision. */
  reapply: () => Promise<SessionEnvBindingResponse>;
}

const FAILED: SessionEnvBindingResponse = {
  success: false,
  binding: null,
  warnings: [],
  error: 'Environment update failed',
};

/**
 * The current Session's Environment Binding state (#170).
 *
 * The observed half is the Agent's report, never a claim derived from the
 * desired selection. A stale response for a previous Session is dropped rather
 * than rendered under the new Session's name.
 */
export function useSessionEnvBinding(sessionId: string | null): SessionEnvBinding {
  const [binding, setBinding] = useState<SessionEnvBindingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
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
        setBinding(resp.binding ?? null);
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

  const mutate = useCallback(
    async (run: () => Promise<SessionEnvBindingResponse>): Promise<SessionEnvBindingResponse> => {
      const id = request.current + 1;
      request.current = id;
      setPending(true);
      try {
        const resp = await run();
        if (request.current === id) {
          if (resp.binding) {
            setBinding(resp.binding);
          }
          setError(resp.success ? (resp.error ?? null) : (resp.error ?? FAILED.error ?? null));
        }
        return resp;
      } catch (e) {
        const resp: SessionEnvBindingResponse = {
          ...FAILED,
          error: e instanceof Error ? e.message : FAILED.error,
        };
        if (request.current === id) {
          setError(resp.error ?? null);
        }
        return resp;
      } finally {
        if (request.current === id) {
          setPending(false);
        }
      }
    },
    [],
  );

  const replace = useCallback(
    (refs: EnvFileRef[]) => {
      if (!sessionId) {
        return Promise.resolve({
          ...FAILED,
          error: 'No Session is selected',
        });
      }
      return mutate(() => envApi.setSessionEnvBinding(sessionId, refs));
    },
    [mutate, sessionId],
  );

  const reapply = useCallback(() => {
    if (!sessionId) {
      return Promise.resolve({
        ...FAILED,
        error: 'No Session is selected',
      });
    }
    return mutate(() => envApi.reapplySessionEnvBinding(sessionId));
  }, [mutate, sessionId]);

  // A Session switch must not keep showing the previous Session's status, and
  // an in-flight request for that Session must not land under the new one.
  useEffect(() => {
    request.current += 1;
    setBinding(null);
    setError(null);
    setPending(false);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { binding, loading, error, pending, refresh, replace, reapply };
}
