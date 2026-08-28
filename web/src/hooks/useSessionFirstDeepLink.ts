import { useCallback, useEffect } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import type { AttachChoice } from '@/components/env/AttachDialog';
import type { AttachedSession } from '@/components/TerminalView';
import {
  attachInfoAtom,
  hasActiveSessionAtom,
  sessionIdAtom,
  sessionIdFromUrlAtom,
  sessionNameAtom,
} from '@/atoms/session';
import { probeResultsAtom } from '@/atoms/probe';
import { useDeepLinkRestore } from '@/hooks/useDeepLinkRestore';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { Session } from '@/types';

/** Deep-link restore for session-first: `#/terminal/:sessionId` auto-attaches and syncs selection. */
export function useSessionFirstDeepLink(opts: {
  sessions: Session[];
  sessionsLoaded: boolean;
  loadingSessions: boolean;
  confirmAttach: (session: Session, choice: AttachChoice) => void;
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
  const wsService = useWebSocket();
  const probeResults = useAtomValue(probeResultsAtom);
  const hasActiveSession = useAtomValue(hasActiveSessionAtom);
  const sessionId = useAtomValue(sessionIdAtom);
  const sessionName = useAtomValue(sessionNameAtom);
  const attachInfo = useAtomValue(attachInfoAtom);
  const [sessionIdFromUrl, setSessionIdFromUrl] = useAtom(sessionIdFromUrlAtom);

  useEffect(() => {
    const raw = terminalMatch?.params?.sessionId;
    setSessionIdFromUrl(raw ? decodeURIComponent(raw) : null);
  }, [terminalMatch?.params?.sessionId, setSessionIdFromUrl]);

  const deepLinkConfirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    onRestoreSession(session);
    confirmAttach(session, choice);
  }, [confirmAttach, onRestoreSession]);

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
    wsService,
    probeResults,
    confirmAttach: deepLinkConfirmAttach,
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

  const isRestoringDeepLink = Boolean(terminalMatch && !hasActiveSession);

  return { isRestoringDeepLink, sessionIdFromUrl };
}
