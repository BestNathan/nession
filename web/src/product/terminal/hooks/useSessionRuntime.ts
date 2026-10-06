import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  attachInfoAtom, manualOverrideAtom,
  orderedUrlsAtom, sessionIdAtom, sessionNameAtom,
} from '@/product/session/state';
import { routeIntentEpochAtom } from '@/platform/attach/state';
import { inputDropAtomFamily } from '@/product/terminal/state/ui';
import { useAddressPlan } from '@/shared/hooks/useAddressPlan';
import { sessionRuntimeRegistry } from '@/platform/session-runtime/SessionRuntimeRegistry';
import { createFilesApi, type FileOps } from '@/capabilities/files';
import { createTerminalAgentApi, type TerminalAgentApi } from '@/product/terminal';
import { ConnectionManager } from '@/platform/terminal-runtime/ConnectionManager';
import type { SessionRuntime, SessionRuntimeConfig, SessionRuntimeSnapshot } from '@/platform/session-runtime/SessionRuntime';
import type { ConnectionState } from '@/platform/socket/types';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';

export interface UseSessionRuntimeOptions {
  /** When true, this hook instance drives registry.update (single config owner). */
  configOwner?: boolean;
  /** Relay-mode server connection handle (build via relayServerHandle(service)). Required for hidden-viewport recovery. */
  serverConnection?: RelayServerTransport;
  /**
   * Whether the Terminal already holds this session's history (#321) — see
   * `SessionRuntimeConfig.hasSessionOutput`. A reader rather than a boolean, so
   * the answer is taken at attach time from the live Terminal.
   */
  hasSessionOutput?: () => boolean;
}

export interface UseSessionRuntimeResult {
  runtime: SessionRuntime | null;
  snapshot: SessionRuntimeSnapshot | null;
  /**
   * Live agent-transport terminal capability — null outside the P2P transport
   * (relay mode, or no candidate selected yet). Connection identity changes
   * flow through this field; consumers bind I/O to it, never to an atom.
   */
  agentTerminalApi: TerminalAgentApi | null;
  /**
   * Live agent-transport connection state. Gated to the P2P transport —
   * 'disconnected' while relay mode owns the session (the relay transport's
   * state is the serverConnection handle, not this).
   */
  connectionState: ConnectionState;
  fileOps: FileOps | null;
  activeUrl: string | null;

  addressUrls: string[];
}

const EMPTY_RUNTIME_SNAPSHOT: SessionRuntimeSnapshot = {
  sessionId: '',
  phase: 'idle',
  transportGeneration: 0,
  connectionState: 'disconnected',
  agentTerminalApi: null,
  activeUrl: null,

  forcedRelay: false,
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
  agentTerminalApi: TerminalAgentApi | null;
  connectionState: ConnectionState;
}

function applyRuntimeMirrorSnapshot(opts: {
  snapshot: import('@/platform/session-runtime/SessionRuntime').RuntimeMirrorSnapshot;
  inP2PTransport: boolean;
  setAgentTerminalApi: (api: TerminalAgentApi | null) => void;
  setConnectionState: (s: ConnectionState) => void;
}): void {
  const {
    snapshot, inP2PTransport,
    setAgentTerminalApi, setConnectionState,
  } = opts;
  // Both mirrors are gated to the P2P transport: outside it the mirror already
  // carries null / 'disconnected', and the gate keeps a stale value from
  // leaking during the same-render flip.
  setAgentTerminalApi(inP2PTransport ? snapshot.agentTerminalApi : null);
  setConnectionState(inP2PTransport ? snapshot.connectionState : 'disconnected');
}

function handleRuntimeEvent(
  event: import('@/platform/session-runtime/SessionRuntime').SessionRuntimeEvent,
  ctx: {
    runtime: SessionRuntime;
    inP2PTransport: boolean;
    setAgentTerminalApi: (api: TerminalAgentApi | null) => void;
  },
): void {
  const { runtime, inP2PTransport, setAgentTerminalApi } = ctx;
  // Only live API binding remains here (#1309 SC-02): the phase, the relay
  // fallback, and exhaustion all publish through the runtime snapshot, so an
  // event that carried no identity change needs no React-side action at all.
  if (
    (event.type === 'next-candidate' || event.type === 'route-intent-changed')
    && inP2PTransport
  ) {
    setAgentTerminalApi(runtime.getAgentTerminalApi());
  }
}

function useRuntimeConnectionSync(opts: {
  sessionId: string | null;
  runtime: SessionRuntime | null;
  runtimeConfig: SessionRuntimeConfig | null;
  inP2PTransport: boolean;
  configOwner: boolean;
}): RuntimeConnectionSyncResult {
  const {
    sessionId,
    runtime,
    runtimeConfig,
    inP2PTransport,
    configOwner,
  } = opts;
  const [agentTerminalApi, setAgentTerminalApi] = useState<TerminalAgentApi | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    if (
      !sessionId
      || !runtime
      || !runtimeConfig
      || runtime.sessionId !== sessionId
      || runtimeConfig.sessionId !== sessionId
    ) {
      setAgentTerminalApi(null);
      setConnectionState('disconnected');
      return;
    }

    const unsubState = inP2PTransport
      ? runtime.subscribeConnectionState((next) => {
        setConnectionState(next);
        if (next === 'connecting') {
          // A fresh transport is being built for a candidate — surface its
          // terminal API so I/O binds to the new socket immediately.
          setAgentTerminalApi(runtime.getAgentTerminalApi());
        }
      })
      : () => {};

    const unsubEvents = runtime.subscribeRuntimeEvents((event) => {
      handleRuntimeEvent(event, {
        runtime,
        inP2PTransport,
        setAgentTerminalApi,
      });
    });

    const snapshot = configOwner
      ? sessionRuntimeRegistry.update(sessionId, runtimeConfig)
      : null;

    if (snapshot) {
      applyRuntimeMirrorSnapshot({
        snapshot,
        inP2PTransport,
        setAgentTerminalApi,
        setConnectionState,
      });
    } else {
      setAgentTerminalApi(inP2PTransport ? runtime.getAgentTerminalApi() : null);
      setConnectionState(inP2PTransport ? runtime.connectionState : 'disconnected');
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
    configOwner,
  ]);

  useEffect(() => {
    if (!inP2PTransport) {
      setAgentTerminalApi(null);
      setConnectionState('disconnected');
    }
  }, [inP2PTransport]);

  return {
    agentTerminalApi: inP2PTransport ? agentTerminalApi : null,
    connectionState: inP2PTransport ? connectionState : 'disconnected',
  };
}

export function useSessionRuntime(options: UseSessionRuntimeOptions): UseSessionRuntimeResult {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const routeIntentEpoch = useAtomValue(routeIntentEpochAtom);
  // The session's own record of input that was lost rather than delivered
  // (#1307 SC-09). Kept in an atom — UI state, not a runtime fact — so the
  // notice survives the transport generation that recorded it; the runtime
  // routes the transport's report here through its config.
  const setInputDrop = useSetAtom(inputDropAtomFamily(sessionId));

  const addressUrls = useAddressPlan(attachInfo, { orderedUrls, manualUrl: manualOverride });

  // Relay has two sources with two owners (#1309 SC-02): the static intent
  // (the attach choice was not P2P) is a config fact this hook computes, and
  // the dynamic fallback (every candidate failed) is a verdict the runtime
  // reached and publishes on its snapshot. The deleted forcedRelayAtom used
  // to round-trip the verdict through React — and a steady-state config sync
  // could clobber it on the way back. The config now carries the intent only;
  // the effective mode is read from the snapshot below.
  const p2pIntent = attachInfo?.mode === 'p2p';

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
      // Static intent only — the runtime's own fallback lives inside the
      // runtime and must never be overwritten by a config sync.
      forcedRelay: !p2pIntent,
      // No P2P intent means no P2P addresses to rotate: the empty plan is the
      // answer, not a pending one (#1430).
      addressUrls: p2pIntent ? addressUrls : [],
      routeIntentEpoch,
      // Retained even while P2P is active: the runtime needs the relay-capable
      // server WS handle in hand when a fallback happens with the Terminal
      // config-owner subtree unmounted.
      serverConnection: attachInfo ? options.serverConnection ?? null : null,
      // Handed to the runtime rather than imported by it — the terminal feature
      // sits above `core/`, so the dependency has to point this way (#783).
      createFilesApi,
      createTerminalAgentApi,
      // The runtime decides when a transport exists and which identity it
      // binds (#1309); the concrete I/O object stays the product layer's.
      createTransport: (opts) => new ConnectionManager(opts),
      onInputDrop: (drop) => setInputDrop(drop),
      hasSessionOutput: options.hasSessionOutput,
    };
  }, [
    sessionId,
    sessionName,
    attachInfo,
    orderedUrls,
    manualOverride,
    p2pIntent,
    addressUrls,
    options.serverConnection,
    options.hasSessionOutput,
    routeIntentEpoch,
    setInputDrop,
  ]);

  const runtime = useRuntimeOwnership(sessionId, attachInfo?.session_id, runtimeConfig);
  const snapshot = useSessionRuntimeSnapshot(runtime);

  // The effective transport: P2P only when the intent is P2P AND the runtime
  // has not fallen back to relay. Before the runtime exists (no snapshot)
  // there is no fallback, so the intent alone decides — the same initial
  // value the deleted atom carried.
  const runtimeForcedRelay = snapshot?.forcedRelay ?? !p2pIntent;
  const inP2PTransport = p2pIntent && !runtimeForcedRelay;

  const { agentTerminalApi, connectionState } = useRuntimeConnectionSync({
    sessionId,
    runtime,
    runtimeConfig,
    inP2PTransport,
    configOwner: options.configOwner ?? false,
  });

  const fileOps: FileOps | null = useMemo(() => {
    if (!inP2PTransport || !runtime || runtime.sessionId !== sessionId || !agentTerminalApi) {
      return null;
    }
    return runtime.getFilesApi()?.toFileOps() ?? null;
  }, [inP2PTransport, runtime, sessionId, agentTerminalApi]);

  return {
    runtime,
    snapshot,
    agentTerminalApi,
    connectionState,
    fileOps,
    activeUrl: runtime?.sessionId === sessionId && inP2PTransport ? runtime.activeUrl ?? null : null,
    addressUrls,
  };
}
