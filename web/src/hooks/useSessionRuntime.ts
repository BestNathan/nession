import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { attachInfoAtom, forcedRelayAtom, manualOverrideAtom, orderedUrlsAtom, sessionIdAtom, sessionNameAtom } from '@/atoms/session';
import { effectiveModeAtom, p2pEpochAtom, p2pConnectionAtom, p2pStateAtom } from '@/atoms/connection';
import { terminalSessionStateAtom } from '@/terminal/state/session';
import { useAddressPlan } from '@/hooks/useAddressPlan';
import { sessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';
import type { SessionRuntime, SessionRuntimeConfig } from '@/runtime/SessionRuntime';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { FileOps } from '@/services/fileOps';

export interface UseSessionRuntimeOptions {
  transportFirst: boolean;
}

function useForcedRelayReset(planUrlsKey: string, setForcedRelay: (v: boolean) => void): void {
  useEffect(() => {
    setForcedRelay(false);
  }, [planUrlsKey, setForcedRelay]);
}

function useRuntimeOwnership(
  sessionId: string | null,
  isP2P: boolean,
  attachSessionId: string | undefined,
  runtimeConfig: SessionRuntimeConfig | null,
): SessionRuntime | null {
  const configRef = useRef(runtimeConfig);
  configRef.current = runtimeConfig;
  const [runtime, setRuntime] = useState<SessionRuntime | null>(null);

  useEffect(() => {
    if (!sessionId || !isP2P || !attachSessionId) {
      setRuntime(null);
      return;
    }
    const config = configRef.current;
    if (!config) {
      setRuntime(null);
      return;
    }

    const rt = sessionRuntimeRegistry.acquire(sessionId, config);
    setRuntime(rt);

    return () => {
      sessionRuntimeRegistry.release(sessionId);
      if (!sessionRuntimeRegistry.get(sessionId)) {
        setRuntime(null);
      }
    };
  }, [sessionId, isP2P, attachSessionId]);

  return runtime;
}

function useRuntimeConnectionSync(opts: {
  runtime: SessionRuntime | null;
  runtimeConfig: SessionRuntimeConfig | null;
  planUrlsKey: string;
  isP2P: boolean;
  setP2pConnection: (c: P2PConnection | null) => void;
  setP2pState: (s: import('@/services/socket/types').ConnectionState) => void;
  setForcedRelay: (v: boolean) => void;
  setTerminalState: (s: import('@/terminal/state/session').TerminalStatus) => void;
  setP2pEpoch: (update: (epoch: number) => number) => void;
}): P2PConnection | null {
  const {
    runtime,
    runtimeConfig,
    planUrlsKey,
    isP2P,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setP2pEpoch,
  } = opts;
  const [p2pConnection, setLocalP2p] = useState<P2PConnection | null>(null);
  const startedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runtime || !runtimeConfig) {
      return;
    }
    runtime.updateContext(runtimeConfig);

    const conn = runtime.getP2PConnection();
    setLocalP2p(conn);
    setP2pConnection(conn);
    const initial = conn?.connectionState ?? 'connecting';
    setP2pState(initial);

    const attemptKey = `${runtime.activeUrl ?? ''}:${planUrlsKey}`;
    if (initial !== 'disconnected') {
      startedKeyRef.current = attemptKey;
    }

    const unsubState = runtime.subscribeConnectionState((next) => {
      setP2pState(next);
      if (next !== 'disconnected') {
        startedKeyRef.current = attemptKey;
        return;
      }
      if (startedKeyRef.current !== attemptKey) {
        return;
      }
      const action = runtime.onCandidateDisconnected();
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
    };
  }, [
    runtime,
    runtimeConfig,
    planUrlsKey,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setP2pEpoch,
  ]);

  useEffect(() => {
    if (!isP2P) {
      setLocalP2p(null);
      setP2pConnection(null);
      setP2pState('disconnected');
      startedKeyRef.current = null;
    }
  }, [isP2P, setP2pConnection, setP2pState]);

  return isP2P ? p2pConnection : null;
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
  const addressPlanReady = addressPlan.ready;

  useForcedRelayReset(planUrlsKey, setForcedRelay);

  const isP2P = effectiveMode === 'p2p' && attachInfo?.mode === 'p2p' && !forcedRelay;

  const runtimeConfig = useMemo((): SessionRuntimeConfig | null => {
    if (!sessionId || !isP2P || !attachInfo) {
      return null;
    }
    return {
      sessionId,
      sessionName,
      attachInfo,
      orderedUrls,
      manualOverride,
      forcedRelay,
      addressPlan: { urls: addressPlan.urls, ready: addressPlanReady },
      transportFirst: options.transportFirst,
      routeEpoch,
    };
  }, [
    sessionId,
    sessionName,
    attachInfo,
    orderedUrls,
    manualOverride,
    forcedRelay,
    isP2P,
    addressPlanReady,
    addressPlan.urls,
    options.transportFirst,
    routeEpoch,
  ]);

  const runtime = useRuntimeOwnership(
    sessionId,
    isP2P,
    attachInfo?.session_id,
    runtimeConfig,
  );

  const p2pConnection = useRuntimeConnectionSync({
    runtime,
    runtimeConfig,
    planUrlsKey,
    isP2P,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setP2pEpoch,
  });

  const fileOps: FileOps | null = useMemo(
    () => (isP2P && runtime ? runtime.getFileCapability()?.toFileOps() ?? null : null),
    [isP2P, runtime],
  );

  return {
    runtime,
    p2pConnection,
    fileOps,
    activeUrl: runtime?.activeUrl ?? null,
    waitingForAddressPlan: isP2P ? (runtime?.waitingForAddressPlan ?? !addressPlanReady) : false,
    addressPlan,
  };
}
