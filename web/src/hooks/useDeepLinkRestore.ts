import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Session } from '../types';
import type { AttachedSession } from '../components/TerminalView';
import type { AttachChoice } from '../components/env/AttachDialog';
import type { AgentProbe } from '../atoms/probe';
import { resolveDeepLinkAttachChoice } from '../services/deepLinkAttach';

/**
 * When the user lands on /terminal/:sessionId with no active attach, wait for
 * sessions to load and auto-attach with a real client.session.attach response.
 * If the session doesn't exist after loading, navigate back to the dashboard.
 */
export function useDeepLinkRestore(opts: {
  pendingSessionId: string | null;
  attachedSession: AttachedSession | null;
  sessionsLoaded: boolean;
  loadingSessions: boolean;
  sessions: Session[];
  probeResults: Map<string, AgentProbe>;
  confirmAttach: (session: Session, choice: AttachChoice) => void;
  navigate: NavigateFunction;
}) {
  const {
    pendingSessionId, attachedSession, sessionsLoaded, loadingSessions,
    sessions, probeResults, confirmAttach, navigate,
  } = opts;

  const confirmedRef = useRef<string | null>(null);
  const probeResultsRef = useRef(probeResults);
  probeResultsRef.current = probeResults;

  useEffect(() => {
    if (!pendingSessionId) {
      confirmedRef.current = null;
    }
  }, [pendingSessionId]);

  useEffect(() => {
    if (!pendingSessionId) { return; }
    if (attachedSession) { return; }
    if (!sessionsLoaded || loadingSessions) { return; }
    if (confirmedRef.current === pendingSessionId) { return; }

    const session = sessions.find((s) => s.session_id === pendingSessionId);
    if (!session) {
      navigate('/', { replace: true });
      return;
    }

    let cancelled = false;
    void resolveDeepLinkAttachChoice(session, probeResultsRef.current)
      .then((choice) => {
        if (cancelled) { return; }
        confirmAttach(session, choice);
        confirmedRef.current = pendingSessionId;
      })
      .catch(() => {
        if (!cancelled) {
          navigate('/', { replace: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    pendingSessionId, attachedSession, sessionsLoaded, loadingSessions,
    sessions, confirmAttach, navigate,
  ]);
}
