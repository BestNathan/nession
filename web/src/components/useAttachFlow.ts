import { useState, useCallback } from 'react';
import type { Session, AttachMode } from '../types';
import type { AttachedSession } from './TerminalView';
import { saveAttachPrefs } from '../services/attachPrefs';

/**
 * Owns the attach-to-terminal transition: the attach dialog, connection-mode
 * selection, and persisting the last-used preference. Keeps Dashboard lean.
 */
export function useAttachFlow(
  handleAttach: (session: Session, mode?: AttachMode) => Promise<void>,
  fetchSessions: () => void,
) {
  const [view, setView] = useState<'dashboard' | 'terminal' | 'env'>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachDialogSession, setAttachDialogSession] = useState<Session | null>(null);

  const attachAndShow = useCallback(
    async (session: Session, mode: AttachMode) => {
      saveAttachPrefs({ mode });
      await handleAttach(session, mode);
      const attached = (handleAttach as unknown as { _attached?: AttachedSession })._attached;
      if (!attached) {
        return;
      }
      setAttachedSession(attached);
      setView('terminal');
    },
    [handleAttach],
  );

  // The Attach button opens the dialog; confirming performs the attach.
  const onAttach = useCallback((session: Session) => setAttachDialogSession(session), []);
  const confirmAttach = useCallback(
    (session: Session, mode: AttachMode) => {
      setAttachDialogSession(null);
      void attachAndShow(session, mode);
    },
    [attachAndShow],
  );

  const backToDashboard = useCallback(() => {
    setAttachedSession(null);
    setView('dashboard');
    fetchSessions();
  }, [fetchSessions]);

  return {
    view, setView,
    attachedSession,
    attachDialogSession, setAttachDialogSession,
    onAttach, confirmAttach,
    backToDashboard,
  };
}
