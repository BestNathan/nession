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
  const navigate = useNavigate();
  const location = useLocation();

  /** Guards a running fast-path validation against double clicks. */
  const inFlightRef = useRef(false);

  const openAttachDialog = useCallback((session: Session, intent: 'attach' | 'configure') => {
    setAttachDialogSession(session);
    setAttachDialogIntent(intent);
  }, [setAttachDialogSession, setAttachDialogIntent]);

  /** Every explicit confirmation persists (or refreshes) the Session profile. */
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
    const profile = loadSessionProfile(session);
    if (!profile) {
      openAttachDialog(session, 'attach');
      return;
    }
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    void (async () => {
      try {
        const resolution = await resolveProfileAttach(session, profile, probeResults);
        if (resolution.kind === 'choice') {
          confirmAttach(session, resolution.choice);
        } else {
          openAttachDialog(session, 'attach');
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [probeResults, confirmAttach, openAttachDialog]);

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
      navigate('/');
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
