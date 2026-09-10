import { useCallback, useEffect } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import type { AttachedSession } from '@/features/terminal/types';
import {
  attachDialogIntentAtom,
  attachDialogSessionAtom,
  attachInfoAtom,
  hasActiveSessionAtom,
  sessionIdAtom,
  sessionIdFromUrlAtom,
  sessionNameAtom,
} from '@/atoms/session';
import { probeResultsAtom } from '@/atoms/probe';
import { useDeepLinkRestore } from '@/app/useDeepLinkRestore';
import type { Session } from '@/types';

/** Deep-link restore for session-first: `#/terminal/:sessionId` auto-attaches and syncs selection. */
export function useSessionFirstDeepLink(opts: {
  sessions: Session[];
  sessionsLoaded: boolean;
  loadingSessions: boolean;
  confirmAttach: (
    session: Session,
    choice: AttachChoice,
    attachOpts?: { persistProfile?: boolean },
  ) => void;
  onRestoreSession: (session: Session) => void;
}) {
  const {
    sessions,
    sessionsLoaded,
    loadingSessions,
    confirmAttach,
    onRestoreSession,
  } = opts;

  const navigate = useNavigate();
  const terminalMatch = useMatch('/terminal/:sessionId');
  const probeResults = useAtomValue(probeResultsAtom);
  const hasActiveSession = useAtomValue(hasActiveSessionAtom);
  const attachDialogSession = useAtomValue(attachDialogSessionAtom);
  const setAttachDialogSession = useSetAtom(attachDialogSessionAtom);
  const setAttachDialogIntent = useSetAtom(attachDialogIntentAtom);
  const sessionId = useAtomValue(sessionIdAtom);
  const sessionName = useAtomValue(sessionNameAtom);
  const attachInfo = useAtomValue(attachInfoAtom);
  const [sessionIdFromUrl, setSessionIdFromUrl] = useAtom(sessionIdFromUrlAtom);

  useEffect(() => {
    const raw = terminalMatch?.params?.sessionId;
    setSessionIdFromUrl(raw ? decodeURIComponent(raw) : null);
  }, [terminalMatch?.params?.sessionId, setSessionIdFromUrl]);

  const deepLinkConfirmAttach = useCallback((
    session: Session,
    choice: AttachChoice,
    attachOpts?: { persistProfile?: boolean },
  ) => {
    onRestoreSession(session);
    confirmAttach(session, choice, attachOpts);
  }, [confirmAttach, onRestoreSession]);

  /** A restore whose saved profile is stale must be re-confirmed in the dialog. */
  const requestConfigForRestore = useCallback((session: Session) => {
    onRestoreSession(session);
    setAttachDialogSession(session);
    setAttachDialogIntent('attach');
  }, [onRestoreSession, setAttachDialogSession, setAttachDialogIntent]);

  const attachedSession: AttachedSession | null =
    hasActiveSession && attachInfo
      ? { sessionId, sessionName, attachInfo }
      : null;

  useDeepLinkRestore({
    pendingSessionId: sessionIdFromUrl,
    attachedSession,
    sessionsLoaded,
    loadingSessions,
    sessions,
    probeResults,
    confirmAttach: deepLinkConfirmAttach,
    requestConfigForRestore,
    navigate,
  });

  useEffect(() => {
    if (!sessionIdFromUrl || sessionId !== sessionIdFromUrl) {
      return;
    }
    const session = sessions.find((s) => s.session_id === sessionIdFromUrl);
    if (session) {
      onRestoreSession(session);
    }
  }, [sessionIdFromUrl, sessionId, sessions, onRestoreSession]);

  // While the config dialog is open (stale profile), do not sit on the
  // restore spinner behind it — the user must resolve the dialog first.
  const isRestoringDeepLink = Boolean(
    terminalMatch && !hasActiveSession && attachDialogSession === null,
  );

  return { isRestoringDeepLink, sessionIdFromUrl };
}
