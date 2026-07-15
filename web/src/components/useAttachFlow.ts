import { useState, useCallback, useMemo } from 'react';
import type { Session } from '../types';
import type { AttachedSession } from './TerminalView';
import type { AttachChoice } from './env/AttachDialog';
import { saveAttachPrefs } from '../services/attachPrefs';

interface LocationLike { pathname: string; }
/** Accepts react-router's navigate or a test mock (vi.fn()). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavigateFn = (...args: any[]) => void;

/**
 * Owns the attach-to-terminal transition. The attach request + browser address
 * test now happen inside the AttachDialog, which hands back a resolved
 * {@link AttachChoice}; this hook just turns that into an AttachedSession and
 * navigates to the terminal route.
 *
 * @param navigate — react-router's navigate (or a mock for tests)
 * @param location — react-router's location (or a mock for tests)
 */
export function useAttachFlow(
  fetchSessions: () => void,
  navigate: NavigateFn,
  location: LocationLike,
) {
  const [attachedSession, setAttachedSession] = useState<AttachedSession | null>(null);
  const [attachDialogSession, setAttachDialogSession] = useState<Session | null>(null);

  // Extract session ID from the current URL for deep-link restoration.
  const pendingTerminalSessionId = useMemo(() => {
    const match = location.pathname.match(/^\/terminal\/(.+)$/);
    return match?.[1] ?? null;
  }, [location.pathname]);

  // The Attach button opens the dialog; confirming (with the resolved choice)
  // navigates to /terminal/:sessionId.
  const onAttach = useCallback((session: Session) => setAttachDialogSession(session), []);

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    setAttachDialogSession(null);
    saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });
    setAttachedSession({
      sessionId: session.session_id,
      sessionName: session.session_name,
      attachInfo: choice.attachInfo,
      orderedUrls: choice.orderedUrls,
      latencies: choice.latencies,
      selectedAddress: choice.selectedUrl ?? undefined,
      renderer: choice.renderer,
    });
    navigate(`/terminal/${encodeURIComponent(session.session_id)}`);
  }, [navigate]);

  const backToDashboard = useCallback(() => {
    setAttachedSession(null);
    navigate('/');
    fetchSessions();
  }, [fetchSessions, navigate]);

  return {
    attachedSession,
    attachDialogSession, setAttachDialogSession,
    onAttach, confirmAttach,
    backToDashboard,
    pendingTerminalSessionId,
  };
}
