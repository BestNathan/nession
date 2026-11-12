import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxCurrentContext } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { sandboxApi } from '../SandboxPlugin';

export interface SandboxContextState {
  loading: boolean;
  context: SandboxCurrentContext | null;
  error: string | null;
  /** Re-read the Agent's observation (also used after a failed transition). */
  refresh: () => void;
  /** Adopt the context an action just returned; no second round trip. */
  applyContext: (context: SandboxCurrentContext | null) => void;
}

/**
 * The authenticated Sandbox context for one Session.
 *
 * Reads are pull-on-open: the capability asks when it is shown and on an
 * explicit refresh. A response that arrives after the Session changed is
 * dropped — it describes a Pane the user is no longer looking at. The Agent
 * owns `inside`/`outside`/`unknown`; this hook never derives it.
 */
export function useSandboxContext(sessionId: string | null): SandboxContextState {
  const [loading, setLoading] = useState(sessionId !== null);
  const [context, setContext] = useState<SandboxCurrentContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const requestSeq = useRef(0);
  const sessionRef = useRef<string | null>(sessionId);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const requested = sessionId;
    const sequence = ++requestSeq.current;
    if (requested === null) {
      setLoading(false);
      setContext(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    sandboxApi
      .context(requested)
      .then((response) => {
        if (cancelled || sequence !== requestSeq.current) {
          return;
        }
        if (!response.success || !response.context) {
          setContext(null);
          setError(response.error ?? 'The Sandbox context is unavailable');
          return;
        }
        setContext(response.context);
      })
      .catch((failure: unknown) => {
        if (cancelled || sequence !== requestSeq.current) {
          return;
        }
        setContext(null);
        setError(failure instanceof Error ? failure.message : 'The Sandbox context is unavailable');
      })
      .finally(() => {
        if (!cancelled && sequence === requestSeq.current) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, epoch]);

  const refresh = useCallback(() => {
    setEpoch((current) => current + 1);
  }, []);

  const applyContext = useCallback((next: SandboxCurrentContext | null) => {
    if (next === null) {
      return;
    }
    setContext(next);
    setError(null);
  }, []);

  return { loading, context, error, refresh, applyContext };
}
