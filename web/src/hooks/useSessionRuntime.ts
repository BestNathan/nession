import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { attachInfoAtom, forcedRelayAtom, manualOverrideAtom, orderedUrlsAtom, sessionIdAtom, sessionNameAtom } from '@/atoms/session';
import { effectiveModeAtom, routeIntentEpochAtom, transportGenerationAtom, p2pConnectionAtom, p2pStateAtom } from '@/atoms/connection';
import { terminalSessionStateAtom, lastResizeAtom, terminalTransportReadyAtom } from '@/terminal/state';
import { useAddressPlan } from '@/hooks/useAddressPlan';
import { sessionRuntimeRegistry } from '@/runtime/SessionRuntimeRegistry';
import type { SessionRuntime, SessionRuntimeConfig, SessionRuntimeSnapshot } from '@/runtime/SessionRuntime';
import type { ConnectionState } from '@/services/socket/types';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import type { FileOps } from '@/services/fileOps';
import type { RelayServerConnection } from '@/runtime/relayServerConnection';

export interface UseSessionRuntimeOptions {
  /** @deprecated Attach ownership is always SessionRuntime-owned. */
  transportFirst?: boolean;
  /** When true, this hook instance drives registry.update (single config owner). */
  configOwner?: boolean;
  /** Relay-mode server lifecycle (beginRelay on reconnect). Required for hidden-viewport recovery. */
  wsService?: RelayServerConnection;
}

export interface UseSessionRuntimeResult {
  runtime: SessionRuntime | null;
  snapshot: SessionRuntimeSnapshot | null;
  p2pConnection: P2PConnection | null;
  p2pState: ConnectionState;
  fileOps: FileOps | null;
  activeUrl: string | null;
  transportKey: string | null;
  waitingForAddressPlan: boolean;
  addressPlan: ReturnType<typeof useAddressPlan>;
}

const EMPTY_RUNTIME_SNAPSHOT: SessionRuntimeSnapshot = {
  sessionId: '',
  phase: 'idle',
  transportGeneration: 0,
  connectionState: 'disconnected',
  p2pConnection: null,
  activeUrl: null,
  waitingForAddressPlan: false,
  transportReady: false,
  lastResize: null,
  reconnectCount: 0,
};
const EMPTY_RUNTIME_SUBSCRIBE = () => () => {};
const EMPTY_RUNTIME_GET_SNAPSHOT = () => EMPTY_RUNTIME_SNAPSHOT;

/** React bridge for runtime-owned state. Jotai remains for UI preferences. */
export function useSessionRuntimeSnapshot(runtime: SessionRuntime | null): SessionRuntimeSnapshot | null {
  const subscribe = runtime?.subscribe ?? EMPTY_RUNTIME_SUBSCRIBE;
  const getSnapshot = runtime?.getSnapshot ?? EMPTY_RUNTIME_GET_SNAPSHOT;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return runtime ? snapshot : null;
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

    const lease = sessionRuntimeRegistry.acquire(sessionId, config);
    setRuntime(lease.runtime);

    return () => {
      lease.release();
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

function applyRuntimeMirrorSnapshot(opts: {
  snapshot: import('@/runtime/SessionRuntime').RuntimeMirrorSnapshot;
  inP2PTransport: boolean;
  mirrorAttachPhase: boolean;
  setTerminalState: (s: import('@/terminal/state/session').TerminalStatus) => void;
  setTransportGeneration: (n: number) => void;
  setLocalP2p: (c: P2PConnection | null) => void;
  setP2pConnection: (c: P2PConnection | null) => void;
  setConnectionState: (s: ConnectionState) => void;
  setP2pState: (s: ConnectionState) => void;
}): void {
  const {
    snapshot, inP2PTransport, mirrorAttachPhase,
    setTerminalState, setTransportGeneration,
    setLocalP2p, setP2pConnection, setConnectionState, setP2pState,
  } = opts;
  if (mirrorAttachPhase) {
    setTerminalState(snapshot.phase);
  }
  setTransportGeneration(snapshot.transportGeneration);
  const conn = inP2PTransport ? snapshot.p2pConnection : null;
  setLocalP2p(conn);
  setP2pConnection(conn);
  setConnectionState(snapshot.connectionState);
  setP2pState(snapshot.connectionState);
}

function handleRuntimeEvent(
  event: import('@/runtime/SessionRuntime').SessionRuntimeEvent,
  ctx: {
    runtime: SessionRuntime;
    inP2PTransport: boolean;
    mirrorAttachPhase: boolean;
    setTerminalState: (s: import('@/terminal/state/session').TerminalStatus) => void;
    setTransportGeneration: (n: number) => void;
    setForcedRelay: (v: boolean) => void;
    setLocalP2p: (c: P2PConnection | null) => void;
    setP2pConnection: (c: P2PConnection | null) => void;
  },
): void {
  const {
    runtime, inP2PTransport, mirrorAttachPhase,
    setTerminalState, setTransportGeneration, setForcedRelay, setLocalP2p, setP2pConnection,
  } = ctx;
  setTransportGeneration(runtime.currentTransportGeneration);
  if (event.type === 'next-candidate') {
    setTerminalState('connecting');
    setLocalP2p(runtime.getP2PConnection());
    setP2pConnection(runtime.getP2PConnection());
    return;
  }
  if (event.type === 'force-relay') {
    if (mirrorAttachPhase) {
      setTerminalState('connecting');
    }
    setForcedRelay(true);
    return;
  }
  if (event.type === 'transport-exhausted') {
    if (mirrorAttachPhase) {
      setTerminalState('failed');
    }
    return;
  }
  if (event.type === 'route-intent-changed') {
    if (mirrorAttachPhase) {
      setTerminalState(event.phase);
    }
    if (inP2PTransport) {
      setLocalP2p(runtime.getP2PConnection());
      setP2pConnection(runtime.getP2PConnection());
    }
  }
}

function useRuntimeConnectionSync(opts: {
  sessionId: string | null;
  runtime: SessionRuntime | null;
  runtimeConfig: SessionRuntimeConfig | null;
  inP2PTransport: boolean;
  configOwner: boolean;
  mirrorAttachPhase: boolean;
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
    mirrorAttachPhase,
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
      handleRuntimeEvent(event, {
        runtime,
        inP2PTransport,
        mirrorAttachPhase,
        setTerminalState,
        setTransportGeneration,
        setForcedRelay,
        setLocalP2p,
        setP2pConnection,
      });
    });

    const snapshot = configOwner
      ? sessionRuntimeRegistry.update(sessionId, runtimeConfig)
      : null;

    if (snapshot) {
      applyRuntimeMirrorSnapshot({
        snapshot,
        inP2PTransport,
        mirrorAttachPhase,
        setTerminalState,
        setTransportGeneration,
        setLocalP2p,
        setP2pConnection,
        setConnectionState,
        setP2pState,
      });
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
    mirrorAttachPhase,
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
      transportFirst: true,
      routeIntentEpoch,
      lastResize,
      transportReady,
      // Retained even while P2P is active: the runtime needs the relay-capable
      // server WS handle in hand when a fallback happens with the Terminal
      // config-owner subtree unmounted.
      serverConnection: attachInfo ? options.wsService ?? null : null,
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
    options.wsService,
    routeIntentEpoch,
    lastResize,
    transportReady,
  ]);

  const runtime = useRuntimeOwnership(sessionId, attachInfo?.session_id, runtimeConfig);
  const snapshot = useSessionRuntimeSnapshot(runtime);

  const { p2pConnection, p2pState } = useRuntimeConnectionSync({
    sessionId,
    runtime,
    runtimeConfig,
    inP2PTransport,
    configOwner: options.configOwner ?? false,
    // Deprecated callers may still opt out of the atom mirror, but this does
    // not change runtime ownership or the transport protocol.
    mirrorAttachPhase: options.transportFirst ?? true,
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
    snapshot,
    p2pConnection,
    p2pState,
    fileOps,
    activeUrl: runtime?.sessionId === sessionId && inP2PTransport ? runtime.activeUrl ?? null : null,
    transportKey: runtime?.sessionId === sessionId ? runtime.transportKey : null,
    waitingForAddressPlan: inP2PTransport ? (runtime?.waitingForAddressPlan ?? !addressPlanReady) : false,
    addressPlan,
  };
}
