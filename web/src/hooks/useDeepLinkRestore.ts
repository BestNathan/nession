import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Session } from '../types';
import type { AttachedSession } from '../components/TerminalView';
import type { AttachChoice } from '../components/env/AttachDialog';

/**
 * When the user lands on /terminal/:sessionId with no active attach, wait for
 * sessions to load and create a shell AttachedSession so the terminal view
 * renders. The connection layer then resolves the transport.
 * If the session doesn't exist after loading, navigate back to the dashboard.
 */
export function useDeepLinkRestore(opts: {
  pendingSessionId: string | null;
  attachedSession: AttachedSession | null;
  loadingSessions: boolean;
  sessions: Session[];
  confirmAttach: (session: Session, choice: AttachChoice) => void;
  navigate: NavigateFunction;
}) {
  const {
    pendingSessionId, attachedSession, loadingSessions,
    sessions, confirmAttach, navigate,
  } = opts;

  const confirmedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingSessionId) { return; }
    if (attachedSession) { return; }
    if (loadingSessions) { return; } // still loading, wait
    // Prevent duplicate confirmAttach calls when sessions array reference changes
    if (confirmedRef.current === pendingSessionId) { return; }

    const session = sessions.find((s) => s.session_id === pendingSessionId);
    if (session) {
      confirmedRef.current = pendingSessionId;
      confirmAttach(session, {
        mode: 'auto',
        attachInfo: { mode: 'p2p', session_id: session.session_id, agent_address: '', connection_token: '' },
        orderedUrls: [],
        latencies: [],
        selectedUrl: null,
        renderer: 'webgl',
      });
    } else {
      // Sessions loaded but the requested one doesn't exist — back to dashboard.
      navigate('/', { replace: true });
    }
  }, [pendingSessionId, attachedSession, loadingSessions, sessions, confirmAttach, navigate]);
}
