import { useCallback, useState } from 'react';
import { sessionsApi } from '@/product/session';
import type { Session } from '@/types';

export interface SessionProjectBindingState {
  target: Session | null;
  busy: boolean;
  error: string | null;
  /** True when the last save lost a race and the selection was kept (#4234). */
  conflict: boolean;
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
 *
 * The editor pins the revision and incarnation it opened with (#4234). A save
 * that loses to a fresher committed membership returns `conflict`; the hook
 * adopts the current token from that reply and keeps the dialog open so the
 * user can review and intentionally retry rather than silently overwriting.
 */
const CONFLICT_MESSAGE =
  'Another change was saved first. Your selection is still here; review the current membership and save again.';

export function useSessionProjectBinding(): SessionProjectBindingState {
  const [target, setTarget] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const open = useCallback((session: Session) => {
    setTarget(session);
    setError(null);
    setConflict(false);
  }, []);
  const close = useCallback(() => {
    if (!busy) {
      setTarget(null);
      setError(null);
      setConflict(false);
    }
  }, [busy]);
  const save = useCallback(
    async (projectId: string | null) => {
      if (!target || busy) {
        return;
      }
      setBusy(true);
      setError(null);
      setConflict(false);
      try {
        const result = await sessionsApi.setProjectBinding(target.session_id, projectId, {
          revision:
            typeof target.project_revision === 'number'
              ? target.project_revision
              : undefined,
          instanceId: target.instance_id ?? undefined,
        });
        if (!result.success) {
          if (result.error_kind === 'conflict') {
            setConflict(true);
            setError(CONFLICT_MESSAGE);
            // Adopt the current token so an explicit retry is guarded by the
            // committed state instead of replaying the stale revision. The
            // dialog keeps the user's selection across this refresh.
            if (typeof result.revision === 'number') {
              const revision = result.revision;
              setTarget((current) =>
                current === null ? current : { ...current, project_revision: revision },
              );
            }
            return;
          }
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

  return { target, busy, error, conflict, open, close, save };
}
