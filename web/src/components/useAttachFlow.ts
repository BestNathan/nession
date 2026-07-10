import { useState, useCallback } from 'react';
import type { Session } from '../types';
import type { AttachedSession } from './TerminalView';
import type { AttachChoice } from './env/AttachDialog';
import { saveAttachPrefs } from '../services/attachPrefs';

/**
 * Owns the attach-to-terminal transition. The attach request + browser address
 * test now happen inside the AttachDialog, which hands back a resolved
 * {@link AttachChoice}; this hook just turns that into an AttachedSession and
 * shows the terminal.
 */
export function useAttachFlow(fetchSessions: () => void) {
  const [view, setView] = useState<'dashboard' | 'terminal' | 'env'>('dashboard');
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachDialogSession, setAttachDialogSession] = useState<Session | null>(null);

  // The Attach button opens the dialog; confirming (with the resolved choice)
  // performs the transition to the terminal view.
  const onAttach = useCallback((session: Session) => setAttachDialogSession(session), []);

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachDialogSession(null);
    saveAttachPrefs({ mode: choice.mode });
    setAttachedSession({
      sessionId: session.session_id,
      sessionName: session.session_name,
      attachInfo: choice.attachInfo,
      orderedUrls: choice.orderedUrls,
      latencies: choice.latencies,
      selectedAddress: choice.selectedUrl ?? undefined,
    });
    setView('terminal');
  }, []);

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
