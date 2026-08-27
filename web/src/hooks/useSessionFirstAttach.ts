import { useCallback, useEffect, useRef, useState } from 'react';
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
  const inflightGen = useRef(0);

  const [attachInFlightId, setAttachInFlightId] = useState<string | null>(null);
  const [attachFailedId, setAttachFailedId] = useState<string | null>(null);

  useEffect(() => () => {
    inflightGen.current += 1;
  }, []);

  const attach = useCallback(async (session: Session) => {
    const gen = ++inflightGen.current;
    const sid = session.session_id;
    setAttachInFlightId(sid);
    setAttachFailedId((prev) => (prev === sid ? null : prev));
    try {
      const choice = await resolveDeepLinkAttachChoice(ws, session, probeResultsRef.current);
      if (gen !== inflightGen.current) {
        return;
      }
      store.set(attachToSessionAtom, { session, choice, navigate });
    } catch {
      if (gen !== inflightGen.current) {
        return;
      }
      setAttachFailedId(sid);
    } finally {
      if (gen === inflightGen.current) {
        setAttachInFlightId(null);
      }
    }
  }, [ws, store, navigate]);

  return { attachInFlightId, attachFailedId, attach };
}
