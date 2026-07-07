import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type { Session, EnvFileRef, AttachMode } from '../types';
import type { WebSocketService } from '../services/websocket';
import type { AttachedSession } from './TerminalView';
import { saveAttachPrefs } from '../services/attachPrefs';

/**
 * Owns the attach-to-terminal transition: the attach dialog, connection-mode
 * selection, optional attach-time env application, detach-time cleanup, and
 * persisting the last-used preferences. Keeps Dashboard lean.
 */
export function useAttachFlow(
  wsService: WebSocketService,
  handleAttach: (session: Session, mode?: AttachMode) => Promise<void>,
  fetchSessions: () => void,
) {
  const [view, setView] = useState<'dashboard' | 'terminal' | 'env'>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachDialogSession, setAttachDialogSession] = useState<Session | null>(null);

  const attachAndShow = useCallback(
    async (session: Session, mode: AttachMode, envFiles: EnvFileRef[]) => {
      // Remember the choice for next time.
      saveAttachPrefs({ mode, envFiles });

      await handleAttach(session, mode);
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

  // The Attach button opens the dialog; confirming performs the attach.
  const onAttach = useCallback((session: Session) => setAttachDialogSession(session), []);
  const confirmAttach = useCallback(
    (session: Session, mode: AttachMode, envFiles: EnvFileRef[]) => {
      setAttachDialogSession(null);
      void attachAndShow(session, mode, envFiles);
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
    attachDialogSession, setAttachDialogSession,
    onAttach, confirmAttach,
    backToDashboard,
  };
}
