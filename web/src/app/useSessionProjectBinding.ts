import { useCallback, useState } from 'react';
import { sessionsApi } from '@/product/session';
import type { Session } from '@/types';

export interface SessionProjectBindingState {
  target: Session | null;
  busy: boolean;
  error: string | null;
  open: (session: Session) => void;
  close: () => void;
  save: (projectId: string | null) => Promise<void>;
}

/**
 * App-composition state for the explicit Session→Project association (#3082).
 *
 * Membership is metadata only; the server broadcasts the updated Session list,
 * so this hook never mutates ENV/process state and does not need to refresh
 * anything beyond the transport push.
 */
export function useSessionProjectBinding(): SessionProjectBindingState {
  const [target, setTarget] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((session: Session) => {
    setTarget(session);
    setError(null);
  }, []);
  const close = useCallback(() => {
    if (!busy) {
      setTarget(null);
      setError(null);
    }
  }, [busy]);
  const save = useCallback(
    async (projectId: string | null) => {
      if (!target || busy) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await sessionsApi.setProjectBinding(target.session_id, projectId);
        if (!result.success) {
          setError(result.error ?? 'Project membership could not be saved');
          return;
        }
        setTarget(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Project membership could not be saved');
      } finally {
        setBusy(false);
      }
    },
    [target, busy],
  );

  return { target, busy, error, open, close, save };
}
