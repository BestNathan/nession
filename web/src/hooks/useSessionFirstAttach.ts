import { useCallback, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { attachToSessionAtom } from '../atoms/session';
import { probeResultsAtom } from '../atoms/probe';
import { resolveDeepLinkAttachChoice } from '../services/deepLinkAttach';
import type { Session } from '../types';
import { useWebSocket } from './useWebSocket';

export function useSessionFirstAttach() {
  const ws = useWebSocket();
  const store = useStore();
  const navigate = useNavigate();
  const probeResults = useAtomValue(probeResultsAtom);
  const probeResultsRef = useRef(probeResults);
  probeResultsRef.current = probeResults;

  const [attachInFlightId, setAttachInFlightId] = useState<string | null>(null);
  const [attachFailedId, setAttachFailedId] = useState<string | null>(null);

  const attach = useCallback(async (session: Session) => {
    const sid = session.session_id;
    setAttachInFlightId(sid);
    setAttachFailedId((prev) => (prev === sid ? null : prev));
    try {
      const choice = await resolveDeepLinkAttachChoice(ws, session, probeResultsRef.current);
      store.set(attachToSessionAtom, { session, choice, navigate });
    } catch {
      setAttachFailedId(sid);
    } finally {
      setAttachInFlightId(null);
    }
  }, [ws, store, navigate]);

  return { attachInFlightId, attachFailedId, attach };
}
