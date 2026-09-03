import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { attachInfoAtom, forcedRelayAtom, manualOverrideAtom, orderedUrlsAtom, sessionIdAtom, sessionNameAtom } from '@/atoms/session';
import { effectiveModeAtom, routeIntentEpochAtom, transportGenerationAtom, p2pConnectionAtom, p2pStateAtom } from '@/atoms/connection';
import { terminalSessionStateAtom, lastResizeAtom, terminalTransportReadyAtom } from '@/terminal/state';
import { useAddressPlan } from '@/hooks/useAddressPlan';
import { sessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';
import type { SessionRuntime, SessionRuntimeConfig } from '@/runtime/SessionRuntime';
import type { ConnectionState } from '@/services/socket/types';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { FileOps } from '@/services/fileOps';

export interface UseSessionRuntimeOptions {
  transportFirst: boolean;
  /** When true, this hook instance drives registry.update (single config owner). */
  configOwner?: boolean;
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
  attachSessionId: string | undefined,
  runtimeConfig: SessionRuntimeConfig | null,
): SessionRuntime | null {
  const configRef = useRef(runtimeConfig);
  configRef.current = runtimeConfig;
  const [runtime, setRuntime] = useState<SessionRuntime | null>(null);

  useEffect(() => {
    if (!sessionId || !attachSessionId || attachSessionId !== sessionId) {
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
  }, [sessionId, attachSessionId]);

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
  inP2PTransport: boolean;
  configOwner: boolean;
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
    inP2PTransport,
    configOwner,
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

    const unsubState = inP2PTransport
      ? runtime.subscribeConnectionState((next) => {
        setConnectionState(next);
        setP2pState(next);
        if (next === 'connecting') {
          setLocalP2p(runtime.getP2PConnection());
          setP2pConnection(runtime.getP2PConnection());
        }
      })
      : () => {};

    const unsubEvents = runtime.subscribeRuntimeEvents((event) => {
      setTransportGeneration(runtime.currentTransportGeneration);
      if (event.type === 'next-candidate') {
        setTerminalState('connecting');
        setLocalP2p(runtime.getP2PConnection());
        setP2pConnection(runtime.getP2PConnection());
      } else if (event.type === 'force-relay') {
        setTerminalState('connecting');
        setForcedRelay(true);
      } else if (event.type === 'transport-exhausted') {
        setTerminalState('failed');
      } else if (event.type === 'route-intent-changed') {
        setTerminalState(event.phase);
        if (inP2PTransport) {
          setLocalP2p(runtime.getP2PConnection());
          setP2pConnection(runtime.getP2PConnection());
        }
      }
    });

    const snapshot = configOwner
      ? sessionRuntimeRegistry.update(sessionId, runtimeConfig)
      : null;

    if (snapshot) {
      setTerminalState(snapshot.phase);
      setTransportGeneration(snapshot.transportGeneration);
      const conn = inP2PTransport ? snapshot.p2pConnection : null;
      setLocalP2p(conn);
      setP2pConnection(conn);
      setConnectionState(snapshot.connectionState);
      setP2pState(snapshot.connectionState);
    } else {
      const conn = inP2PTransport ? runtime.getP2PConnection() : null;
      setLocalP2p(conn);
      setP2pConnection(conn);
      const initial = conn?.connectionState ?? 'disconnected';
      setConnectionState(initial);
      setP2pState(initial);
      setTransportGeneration(runtime.currentTransportGeneration);
    }

    return () => {
      unsubState();
      unsubEvents();
    };
  }, [
    sessionId,
    runtime,
    runtimeConfig,
    inP2PTransport,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setTransportGeneration,
    configOwner,
  ]);

  useEffect(() => {
    if (!inP2PTransport) {
      setLocalP2p(null);
      setConnectionState('disconnected');
      setP2pConnection(null);
      setP2pState('disconnected');
    }
  }, [inP2PTransport, setP2pConnection, setP2pState]);

  return {
    p2pConnection: inP2PTransport ? p2pConnection : null,
    p2pState: inP2PTransport ? connectionState : 'disconnected',
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
  const lastResize = useAtomValue(lastResizeAtom);
  const transportReady = useAtomValue(terminalTransportReadyAtom);
  const setP2pConnection = useSetAtom(p2pConnectionAtom);
  const setP2pState = useSetAtom(p2pStateAtom);
  const setTerminalState = useSetAtom(terminalSessionStateAtom);
  const setTransportGeneration = useSetAtom(transportGenerationAtom);

  const forcedRelay = manualOverride ? false : forcedRelayState;
  const addressPlan = useAddressPlan(attachInfo, { orderedUrls, manualUrl: manualOverride });
  const planUrlsKey = addressPlan.urls.join(',');
  const addressPlanReady = addressPlan.ready;

  useForcedRelayReset(planUrlsKey, setForcedRelay);

  const inP2PTransport = effectiveMode === 'p2p' && attachInfo?.mode === 'p2p' && !forcedRelay;

  const runtimeConfig = useMemo((): SessionRuntimeConfig | null => {
    if (!sessionId || !attachInfo) {
      return null;
    }
    return {
      sessionId,
      sessionName,
      attachInfo,
      orderedUrls,
      manualOverride,
      forcedRelay: inP2PTransport ? forcedRelay : true,
      addressPlan: inP2PTransport
        ? { urls: addressPlan.urls, ready: addressPlanReady }
        : { urls: [], ready: true },
      transportFirst: options.transportFirst,
      routeIntentEpoch,
      lastResize,
      transportReady,
    };
  }, [
    sessionId,
    sessionName,
    attachInfo,
    orderedUrls,
    manualOverride,
    forcedRelay,
    inP2PTransport,
    addressPlanReady,
    addressPlan.urls,
    options.transportFirst,
    routeIntentEpoch,
    lastResize,
    transportReady,
  ]);

  const runtime = useRuntimeOwnership(sessionId, attachInfo?.session_id, runtimeConfig);

  const { p2pConnection, p2pState } = useRuntimeConnectionSync({
    sessionId,
    runtime,
    runtimeConfig,
    inP2PTransport,
    configOwner: options.configOwner ?? false,
    setP2pConnection,
    setP2pState,
    setForcedRelay,
    setTerminalState,
    setTransportGeneration,
  });

  const fileOps: FileOps | null = useMemo(() => {
    if (!inP2PTransport || !runtime || runtime.sessionId !== sessionId || !p2pConnection) {
      return null;
    }
    return runtime.getFileCapability()?.toFileOps() ?? null;
  }, [inP2PTransport, runtime, sessionId, p2pConnection]);

  return {
    runtime,
    p2pConnection,
    p2pState,
    fileOps,
    activeUrl: runtime?.sessionId === sessionId && inP2PTransport ? runtime.activeUrl ?? null : null,
    transportKey: runtime?.sessionId === sessionId ? runtime.transportKey : null,
    waitingForAddressPlan: inP2PTransport ? (runtime?.waitingForAddressPlan ?? !addressPlanReady) : false,
    addressPlan,
  };
}
