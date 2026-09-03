import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { attachInfoAtom, forcedRelayAtom, manualOverrideAtom, orderedUrlsAtom, sessionIdAtom, sessionNameAtom } from '@/atoms/session';
import { effectiveModeAtom, routeIntentEpochAtom, transportGenerationAtom, p2pConnectionAtom, p2pStateAtom } from '@/atoms/connection';
import { terminalSessionStateAtom } from '@/terminal/state/session';
import { useAddressPlan } from '@/hooks/useAddressPlan';
import { sessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';
import type { SessionRuntime, SessionRuntimeConfig } from '@/runtime/SessionRuntime';
import type { ConnectionState } from '@/services/socket/types';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { FileOps } from '@/services/fileOps';

export interface UseSessionRuntimeOptions {
  transportFirst: boolean;
}

export interface UseSessionRuntimeResult {
  runtime: SessionRuntime | null;
  p2pConnection: P2PConnection | null;
  p2pState: ConnectionState;
  fileOps: FileOps | null;
  activeUrl: string | null;
  transportKey: string | null;
  waitingForAddressPlan: boolean;
  addressPlan: ReturnType<typeof useAddressPlan>;
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
    if (!config || config.sessionId !== sessionId) {
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

  if (!sessionId || !runtime || runtime.sessionId !== sessionId) {
    return null;
  }
  return runtime;
}

interface RuntimeConnectionSyncResult {
  p2pConnection: P2PConnection | null;
  p2pState: ConnectionState;
}

function useRuntimeConnectionSync(opts: {
  sessionId: string | null;
  runtime: SessionRuntime | null;
  runtimeConfig: SessionRuntimeConfig | null;
  isP2P: boolean;
  setP2pConnection: (c: P2PConnection | null) => void;
  setP2pState: (s: ConnectionState) => void;
  setForcedRelay: (v: boolean) => void;
  setTerminalState: (s: import('@/terminal/state/session').TerminalStatus) => void;
  setTransportGeneration: (n: number) => void;
}): RuntimeConnectionSyncResult {
  const {
    sessionId,
    runtime,
    runtimeConfig,
    isP2P,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setTransportGeneration,
  } = opts;
  const [p2pConnection, setLocalP2p] = useState<P2PConnection | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    if (
      !sessionId
      || !runtime
      || !runtimeConfig
      || runtime.sessionId !== sessionId
      || runtimeConfig.sessionId !== sessionId
    ) {
      setLocalP2p(null);
      setConnectionState('disconnected');
      setP2pConnection(null);
      setP2pState('disconnected');
      return;
    }

    runtime.updateContext(runtimeConfig);

    const conn = runtime.getP2PConnection();
    setLocalP2p(conn);
    setP2pConnection(conn);
    const initial = conn?.connectionState ?? 'connecting';
    setConnectionState(initial);
    setP2pState(initial);

    const unsubState = runtime.subscribeConnectionState((next) => {
      setConnectionState(next);
      setP2pState(next);
      if (next === 'connecting') {
        setLocalP2p(runtime.getP2PConnection());
        setP2pConnection(runtime.getP2PConnection());
      }
    });

    const unsubEvents = runtime.subscribeRuntimeEvents((event) => {
      setTransportGeneration(runtime.currentTransportGeneration);
      if (event.type === 'next-candidate') {
        setTerminalState('connecting');
        setLocalP2p(runtime.getP2PConnection());
        setP2pConnection(runtime.getP2PConnection());
      } else if (event.type === 'force-relay') {
        setTerminalState('connecting');
        setForcedRelay(true);
      }
    });

    setTransportGeneration(runtime.currentTransportGeneration);

    return () => {
      unsubState();
      unsubEvents();
    };
  }, [
    sessionId,
    runtime,
    runtimeConfig,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setTransportGeneration,
  ]);

  useEffect(() => {
    if (!isP2P) {
      setLocalP2p(null);
      setConnectionState('disconnected');
      setP2pConnection(null);
      setP2pState('disconnected');
    }
  }, [isP2P, setP2pConnection, setP2pState]);

  return {
    p2pConnection: isP2P ? p2pConnection : null,
    p2pState: isP2P ? connectionState : 'disconnected',
  };
}

export function useSessionRuntime(options: UseSessionRuntimeOptions): UseSessionRuntimeResult {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [forcedRelayState, setForcedRelay] = useAtom(forcedRelayAtom);
  const effectiveMode = useAtomValue(effectiveModeAtom);
  const routeIntentEpoch = useAtomValue(routeIntentEpochAtom);
  const setP2pConnection = useSetAtom(p2pConnectionAtom);
  const setP2pState = useSetAtom(p2pStateAtom);
  const setTerminalState = useSetAtom(terminalSessionStateAtom);
  const setTransportGeneration = useSetAtom(transportGenerationAtom);

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
      routeIntentEpoch,
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
    routeIntentEpoch,
  ]);

  const runtime = useRuntimeOwnership(
    sessionId,
    isP2P,
    attachInfo?.session_id,
    runtimeConfig,
  );

  const { p2pConnection, p2pState } = useRuntimeConnectionSync({
    sessionId,
    runtime,
    runtimeConfig,
    isP2P,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setTransportGeneration,
  });

  const fileOps: FileOps | null = useMemo(() => {
    if (!isP2P || !runtime || runtime.sessionId !== sessionId || !p2pConnection) {
      return null;
    }
    return runtime.getFileCapability()?.toFileOps() ?? null;
  }, [isP2P, runtime, sessionId, p2pConnection]);

  return {
    runtime,
    p2pConnection,
    p2pState,
    fileOps,
    activeUrl: runtime?.sessionId === sessionId ? runtime.activeUrl ?? null : null,
    transportKey: runtime?.sessionId === sessionId ? runtime.transportKey : null,
    waitingForAddressPlan: isP2P ? (runtime?.waitingForAddressPlan ?? !addressPlanReady) : false,
    addressPlan,
  };
}
