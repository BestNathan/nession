import { useCallback, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AttachChoice } from '@/features/sessions/components/AttachDialog';
import {
  attachDialogIntentAtom,
  attachDialogSessionAtom,
  attachToSessionAtom,
  sessionIdAtom,
} from '../atoms/session';
import { terminalSessionStateAtom } from '@/features/terminal/state/session';
import { saveAttachPrefs } from '../services/attachPrefs';
import { probeResultsAtom } from '../atoms/probe';
import { resolveProfileAttach } from '../services/deepLinkAttach';
import { loadSessionProfile, persistConfirmedChoice } from '../services/sessionAttachProfile';
import type { Session } from '../types';

/** Session-first attach: profile-aware dialog bypass + explicit configure. */
export function useSessionFirstAttach() {
  const [attachDialogSession, setAttachDialogSession] = useAtom(attachDialogSessionAtom);
  const setAttachDialogIntent = useSetAtom(attachDialogIntentAtom);
  const attachToSession = useSetAtom(attachToSessionAtom);
  const probeResults = useAtomValue(probeResultsAtom);
  const clientSessionId = useAtomValue(sessionIdAtom);
  const terminalState = useAtomValue(terminalSessionStateAtom);
  const navigate = useNavigate();
  const location = useLocation();

  /** Session + flight owning the in-flight fast-path validation slot. A second
   *  requestAttach for the SAME session whose validation is running is ignored
   *  (double-click guard, #668 epoch hazard); a different session may start
   *  and overwrite the slot (last-started wins). The per-flight token keeps an
   *  overtaken flight's finally from clearing a slot a NEWER flight for the
   *  same session owns (A → B → A: flight 1 must not clear flight 3's guard). */
  const inFlightRef = useRef<{ sessionId: string; token: number } | null>(null);
  const nextTokenRef = useRef(0);

  const openAttachDialog = useCallback((session: Session, intent: 'attach' | 'configure') => {
    setAttachDialogSession(session);
    setAttachDialogIntent(intent);
  }, [setAttachDialogSession, setAttachDialogIntent]);

  /** Every explicit confirmation persists (or refreshes) the Session profile;
   *  non-explicit paths (deep-link restore) opt out via `{ persistProfile: false }`. */
  const confirmAttach = useCallback((
    session: Session,
    choice: AttachChoice,
    opts: { persistProfile?: boolean } = {},
  ) => {
    saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });
    if (opts.persistProfile !== false) {
      // The fingerprint must reflect the FRESH options the choice was built
      // against — choice.attachInfo always comes from the latest requestAttach.
      persistConfirmedChoice(session, choice, choice.attachInfo);
    }
    attachToSession({ session, choice, navigate });
  }, [attachToSession, navigate]);

  /** Row click entry: no profile → dialog; profile → validate, attach or dialog. */
  const requestAttach = useCallback((session: Session) => {
    // Clicking the row of the session we are already attached to: while the
    // terminal is healthy there is nothing to do — a fast-path re-attach
    // would tear down the live runtime (route-epoch bump, #668 class). When
    // the terminal FAILED, fall through to the dialog so recovery stays an
    // explicit user action.
    if (clientSessionId === session.session_id) {
      if (terminalState !== 'failed') {
        return;
      }
      openAttachDialog(session, 'attach');
      return;
    }
    const profile = loadSessionProfile(session);
    if (!profile) {
      openAttachDialog(session, 'attach');
      return;
    }
    if (inFlightRef.current !== null && inFlightRef.current.sessionId === session.session_id) {
      return;
    }
    const token = ++nextTokenRef.current;
    inFlightRef.current = { sessionId: session.session_id, token };
    void (async () => {
      try {
        const resolution = await resolveProfileAttach(session, profile, probeResults);
        if (resolution.kind === 'choice') {
          confirmAttach(session, resolution.choice);
        } else {
          openAttachDialog(session, 'attach');
        }
      } finally {
        // Only the owning flight clears the slot: a later start for the same
        // session holds a HIGHER token and a different-session start replaced
        // the entry entirely — this flight's end clears neither.
        if (inFlightRef.current?.token === token) {
          inFlightRef.current = null;
        }
      }
    })();
  }, [probeResults, confirmAttach, openAttachDialog, clientSessionId, terminalState]);

  /** Session-row Settings entry: dialog in configure mode (persist only). */
  const openAttachSettings = useCallback((session: Session) => {
    openAttachDialog(session, 'configure');
  }, [openAttachDialog]);

  const cancelAttach = useCallback(() => {
    setAttachDialogSession(null);
    setAttachDialogIntent('attach');
    // A restore that landed on /terminal/:sessionId with nothing attached and
    // whose dialog was cancelled must leave: nothing would re-drive the
    // attach, and the restore effect would otherwise re-fire on every poll.
    if (clientSessionId === '' && location.pathname.startsWith('/terminal/')) {
      // Replace, not push: a push would let Back return to /terminal/:sid and
      // re-fire the restore effect the heuristic exists to break.
      navigate('/', { replace: true });
    }
  }, [setAttachDialogSession, setAttachDialogIntent, clientSessionId, location.pathname, navigate]);

  return {
    attachDialogSession,
    requestAttach,
    confirmAttach,
    cancelAttach,
    openAttachSettings,
  };
}
