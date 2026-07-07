import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type { Session, EnvFileRef } from '../types';
import type { WebSocketService } from '../services/websocket';
import type { AttachedSession } from './TerminalView';

/**
 * Owns the attach-to-terminal transition, including optional attach-time env
 * application and detach-time cleanup. Keeps Dashboard lean.
 */
export function useAttachFlow(
  wsService: WebSocketService,
  handleAttach: (session: Session) => Promise<void>,
  fetchSessions: () => void,
) {
  const [view, setView] = useState<'dashboard' | 'terminal' | 'env'>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachEnvSession, setAttachEnvSession] = useState<Session | null>(null);

  const attachAndShow = useCallback(
    async (session: Session, envFiles: EnvFileRef[]) => {
      await handleAttach(session);
      const attached = (handleAttach as unknown as { _attached?: AttachedSession })._attached;
      if (!attached) {
        return;
      }
      let appliedEnv: EnvFileRef[] = [];
      if (envFiles.length > 0) {
        try {
          const resp = await wsService.applySessionEnv(session.session_id, envFiles);
          if (resp.success) {
            appliedEnv = envFiles;
            const warns = resp.warnings ?? [];
            if (warns.length > 0) {
              toast.warning(`Env applied with warnings: ${warns.join('; ')}`);
            } else {
              toast.success(`Applied ${envFiles.length} env file(s)`);
            }
          } else {
            toast.error(resp.error ?? 'Failed to apply env files');
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Failed to apply env files');
        }
      }
      setAttachedSession({ ...attached, appliedEnv });
      setView('terminal');
    },
    [handleAttach, wsService],
  );

  const onAttach = useCallback((session: Session) => void attachAndShow(session, []), [attachAndShow]);
  const onAttachWithEnv = useCallback((session: Session) => setAttachEnvSession(session), []);
  const confirmAttachEnv = useCallback(
    (session: Session, envFiles: EnvFileRef[]) => {
      setAttachEnvSession(null);
      void attachAndShow(session, envFiles);
    },
    [attachAndShow],
  );

  const backToDashboard = useCallback(() => {
    const applied = attachedSession?.appliedEnv;
    if (attachedSession && applied && applied.length > 0) {
      void wsService.unsetSessionEnv(attachedSession.sessionId, applied).catch(() => undefined);
    }
    setAttachedSession(null);
    setView('dashboard');
    fetchSessions();
  }, [attachedSession, wsService, fetchSessions]);

  return {
    view, setView,
    attachedSession,
    attachEnvSession, setAttachEnvSession,
    onAttach, onAttachWithEnv, confirmAttachEnv,
    backToDashboard,
  };
}
