import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Session } from '../types';
import type { AttachedSession } from '@/features/terminal/types';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import type { AgentProbe } from '../atoms/probe';
import { resolveDeepLinkAttachChoice, resolveProfileAttach } from '../services/deepLinkAttach';
import { loadSessionProfile } from '../services/sessionAttachProfile';

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
  confirmAttach: (
    session: Session,
    choice: AttachChoice,
    attachOpts?: { persistProfile?: boolean },
  ) => void;
  /** Open the attach dialog for a session whose saved profile is stale. */
  requestConfigForRestore: (session: Session) => void;
  navigate: NavigateFunction;
}) {
  const {
    pendingSessionId, attachedSession, sessionsLoaded, loadingSessions,
    sessions, probeResults, confirmAttach, requestConfigForRestore, navigate,
  } = opts;

  const confirmedRef = useRef<string | null>(null);
  const configRequestedRef = useRef<string | null>(null);
  const probeResultsRef = useRef(probeResults);
  probeResultsRef.current = probeResults;

  useEffect(() => {
    if (!pendingSessionId) {
      confirmedRef.current = null;
      configRequestedRef.current = null;
    }
  }, [pendingSessionId]);

  useEffect(() => {
    if (!pendingSessionId) { return; }
    if (attachedSession) { return; }
    if (!sessionsLoaded || loadingSessions) { return; }
    if (confirmedRef.current === pendingSessionId) { return; }
    if (configRequestedRef.current === pendingSessionId) { return; }

    const session = sessions.find((s) => s.session_id === pendingSessionId);
    if (!session) {
      navigate('/', { replace: true });
      return;
    }

    let cancelled = false;
    // A saved per-session profile changes the restore semantics: a VALID
    // profile re-applies its choice (default persist refreshes the profile,
    // keeping the fingerprint in sync with the fresh attach info). A STALE
    // profile (fingerprint / manual url / renderer mismatch) cannot attach
    // silently — its saved options no longer apply, so the dialog opens for
    // re-confirmation. No profile keeps the legacy no-profile restore below.
    const profile = loadSessionProfile(session);
    if (profile === null) {
      void resolveDeepLinkAttachChoice(session, probeResultsRef.current)
        .then((choice) => {
          if (cancelled) { return; }
          // Restore is never an explicit user confirmation: a profile is only
          // created by the user confirming in the dialog / on a row.
          confirmAttach(session, choice, { persistProfile: false });
          confirmedRef.current = pendingSessionId;
        })
        .catch(() => {
          if (!cancelled) {
            navigate('/', { replace: true });
          }
        });
    } else {
      void resolveProfileAttach(session, profile, probeResultsRef.current)
        .then((resolution) => {
          if (cancelled) { return; }
          if (resolution.kind === 'choice') {
            confirmAttach(session, resolution.choice);
            confirmedRef.current = pendingSessionId;
            return;
          }
          // Mark the session so the effect does not re-fire on every poll
          // while the dialog is open. Confirm does not clear the mark — the
          // attachedSession guard makes it moot; the mark clears when
          // pendingSessionId becomes null (cancel navigates home) or in the
          // !pendingSessionId reset effect.
          configRequestedRef.current = pendingSessionId;
          requestConfigForRestore(session);
        })
        .catch(() => {
          // resolveProfileAttach never rejects — failures surface as the
          // dialog verdict; this catch is defensive.
          if (!cancelled) {
            navigate('/', { replace: true });
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    pendingSessionId, attachedSession, sessionsLoaded, loadingSessions,
    sessions, confirmAttach, requestConfigForRestore, navigate,
  ]);
}
