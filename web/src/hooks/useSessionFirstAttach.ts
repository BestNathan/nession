import { useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { useNavigate } from 'react-router-dom';
import type { AttachChoice } from '../components/env/AttachDialog';
import { attachDialogSessionAtom, attachToSessionAtom } from '../atoms/session';
import { saveAttachPrefs } from '../services/attachPrefs';
import type { Session } from '../types';

/** Session-first attach: open AttachDialog on select, confirm via attachToSessionAtom. */
export function useSessionFirstAttach() {
  const [attachDialogSession, setAttachDialogSession] = useAtom(attachDialogSessionAtom);
  const attachToSession = useSetAtom(attachToSessionAtom);
  const navigate = useNavigate();

  const requestAttach = useCallback((session: Session) => {
    setAttachDialogSession(session);
  }, [setAttachDialogSession]);

  const confirmAttach = useCallback((session: Session, choice: AttachChoice) => {
    saveAttachPrefs({ mode: choice.mode, renderer: choice.renderer });
    attachToSession({ session, choice, navigate });
  }, [attachToSession, navigate]);

  const cancelAttach = useCallback(() => {
    setAttachDialogSession(null);
  }, [setAttachDialogSession]);

  return { attachDialogSession, requestAttach, confirmAttach, cancelAttach };
}
