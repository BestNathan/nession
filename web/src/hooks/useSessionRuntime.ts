import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { attachInfoAtom, forcedRelayAtom, manualOverrideAtom, orderedUrlsAtom, sessionIdAtom, sessionNameAtom } from '@/atoms/session';
import { effectiveModeAtom, p2pEpochAtom, p2pConnectionAtom, p2pStateAtom } from '@/atoms/connection';
import { terminalSessionStateAtom } from '@/terminal/state/session';
import { useAddressPlan } from '@/hooks/useAddressPlan';
import { sessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';
import type { SessionRuntime } from '@/runtime/SessionRuntime';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { FileOps } from '@/services/fileOps';

export interface UseSessionRuntimeOptions {
  transportFirst: boolean;
}

export function useSessionRuntime(options: UseSessionRuntimeOptions) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [forcedRelayState, setForcedRelay] = useAtom(forcedRelayAtom);
  const effectiveMode = useAtomValue(effectiveModeAtom);
  const routeEpoch = useAtomValue(p2pEpochAtom);
  const setP2pEpoch = useSetAtom(p2pEpochAtom);
  const setP2pConnection = useSetAtom(p2pConnectionAtom);
  const setP2pState = useSetAtom(p2pStateAtom);
  const setTerminalState = useSetAtom(terminalSessionStateAtom);

  const forcedRelay = manualOverride ? false : forcedRelayState;
  const addressPlan = useAddressPlan(attachInfo, { orderedUrls, manualUrl: manualOverride });
  const planUrlsKey = addressPlan.urls.join(',');

  useEffect(() => {
    setForcedRelay(false);
  }, [planUrlsKey, setForcedRelay]);

  const isP2P = effectiveMode === 'p2p' && attachInfo?.mode === 'p2p' && !forcedRelay;

  const [runtime, setRuntime] = useState<SessionRuntime | null>(null);
  const [p2pConnection, setLocalP2p] = useState<P2PConnection | null>(null);
  const startedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || !isP2P || !attachInfo) {
      setRuntime(null);
      setLocalP2p(null);
      setP2pConnection(null);
      setP2pState('disconnected');
      startedKeyRef.current = null;
      return;
    }

    const rt = sessionRuntimeRegistry.acquire(sessionId, {
      sessionId,
      sessionName,
      attachInfo,
      orderedUrls,
      manualOverride,
      forcedRelay,
      addressPlan,
      transportFirst: options.transportFirst,
      routeEpoch,
    });
    setRuntime(rt);

    const conn = rt.getP2PConnection();
    setLocalP2p(conn);
    setP2pConnection(conn);
    const initial = conn?.connectionState ?? 'connecting';
    setP2pState(initial);

    const attemptKey = `${rt.activeUrl ?? ''}:${planUrlsKey}`;
    if (initial !== 'disconnected') {
      startedKeyRef.current = attemptKey;
    }

    const unsubState = rt.subscribeConnectionState((next) => {
      setP2pState(next);
      if (next !== 'disconnected') {
        startedKeyRef.current = attemptKey;
        return;
      }
      if (startedKeyRef.current !== attemptKey) {
        return;
      }
      const action = rt.onCandidateDisconnected();
      if (action === 'next-candidate') {
        setP2pEpoch((e) => e + 1);
        setTerminalState('connecting');
      } else if (action === 'force-relay') {
        setP2pEpoch((e) => e + 1);
        setTerminalState('connecting');
        setForcedRelay(true);
      }
    });

    return () => {
      unsubState();
      sessionRuntimeRegistry.release(sessionId);
      if (!sessionRuntimeRegistry.get(sessionId)) {
        setP2pConnection(null);
        setP2pState('disconnected');
      }
    };
  }, [
    sessionId,
    sessionName,
    attachInfo,
    orderedUrls,
    manualOverride,
    forcedRelay,
    isP2P,
    addressPlan,
    planUrlsKey,
    routeEpoch,
    options.transportFirst,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setP2pEpoch,
  ]);

  const fileOps: FileOps | null = useMemo(
    () => (isP2P && runtime ? runtime.getFileCapability()?.toFileOps() ?? null : null),
    [isP2P, runtime],
  );

  return {
    runtime,
    p2pConnection: isP2P ? p2pConnection : null,
    fileOps,
    activeUrl: runtime?.activeUrl ?? null,
    waitingForAddressPlan: isP2P ? (runtime?.waitingForAddressPlan ?? !addressPlan.ready) : false,
    addressPlan,
  };
}
