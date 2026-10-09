import { useCallback, useEffect, useRef } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AttachChoice } from '@/product/session/components/AttachDialog';
import type { AttachedSession } from '@/product/terminal/types';
import {
  attachDialogIntentAtom,
  attachDialogSessionAtom,
  attachInfoAtom,
  hasActiveSessionAtom,
  sessionIdAtom,
  sessionNameAtom,
} from '@/product/session/state';
import { probeResultsAtom } from '@/product/agent/state';
import { useDeepLinkRestore } from '@/app/useDeepLinkRestore';
import type { Session } from '@/types';

/** Deep-link restore for shell: `#/terminal/:sessionId` auto-attaches and syncs selection. */
export function useDeepLink(opts: {
  sessions: Session[];
  sessionsLoaded: boolean;
  loadingSessions: boolean;
  confirmAttach: (
    session: Session,
    choice: AttachChoice,
    attachOpts?: { persistProfile?: boolean },
  ) => void;
  onRestoreSession: (session: Session) => void;
  requestAttach: (session: Session) => void;
}) {
  const {
    sessions,
    sessionsLoaded,
    loadingSessions,
    confirmAttach,
    onRestoreSession,
    requestAttach,
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
  // Read the URL session synchronously from the route match — never from a
  // state mirror of it. A mirror copied via effect lags one render behind the
  // router, and in that window a programmatic `attachToSession` (which writes
  // sessionIdAtom and navigates in the same commit) reads as
  // (url=old, attached=new) — "URL wants the old session" — and the switch
  // effect below bounced the fresh attach back to the old session (#1396).
  const sessionIdFromUrl = terminalMatch?.params?.sessionId
    ? decodeURIComponent(terminalMatch.params.sessionId)
    : null;

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

  // The URL this effect has already acted on. A switch is triggered by the
  // URL, never by the attach atom: navigate() lands via a React transition,
  // so `attachToSession` (sessionIdAtom write + navigate in one jotai write)
  // commits first as (url=old, sessionId=new) — reading that window as
  // "URL wants the old session" bounced every fresh attach back (#1396).
  // Acting on each URL value at most once keeps URL-wins semantics for real
  // deep links while ignoring the atom→URL propagation window.
  const handledUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionIdFromUrl) {
      handledUrlRef.current = null;
      return;
    }
    // Already attached to the URL session - just sync UI selection
    if (sessionId === sessionIdFromUrl) {
      handledUrlRef.current = sessionIdFromUrl;
      const session = sessions.find((s) => s.session_id === sessionIdFromUrl);
      if (session) {
        onRestoreSession(session);
      }
      return;
    }
    // URL points to a different session than what we're attached to
    // If we're already attached to SOME session (sessionId is non-empty), trigger a switch
    // If we're not attached (sessionId is empty), useDeepLinkRestore handles the initial attach
    if (sessionId && handledUrlRef.current !== sessionIdFromUrl) {
      const session = sessions.find((s) => s.session_id === sessionIdFromUrl);
      if (session) {
        handledUrlRef.current = sessionIdFromUrl;
        onRestoreSession(session);
        requestAttach(session);
      }
    }
  }, [sessionIdFromUrl, sessionId, sessions, onRestoreSession, requestAttach]);

  // While the config dialog is open (stale profile), do not sit on the
  // restore spinner behind it — the user must resolve the dialog first.
  const isRestoringDeepLink = Boolean(
    terminalMatch && !hasActiveSession && attachDialogSession === null,
  );

  return { isRestoringDeepLink, sessionIdFromUrl };
}
