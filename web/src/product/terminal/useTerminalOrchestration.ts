import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { useP2PAttachTransport } from '@/product/terminal/hooks/useP2PAttachTransport';
import { useWebSocket } from '@/shared/hooks/useWebSocket';
import { envApi } from '@/capabilities/env';
import type { TerminalAgentApi } from '@/product/terminal/agent';
import type { ConnectionState } from '@/platform/socket/types';
import {
  relayServerHandle,
  type RelayServerHandle,
  type RelayServerTransport,
} from '@/platform/attach/relayServerConnection';
import type { EnvFileRef } from '@/types';
import {
  attachInfoAtom,
  effectiveModeAtom,
  envRefsAtom,
  isSwitchingAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  sessionIdAtom,
  sessionNameAtom,
} from '@/product/session/state';
import { terminalServerApi } from '@/product/terminal';
import { useTerminal } from '@/product/terminal/hooks/useTerminal';
import { useTerminalAttach } from '@/product/terminal/useTerminalAttach';
import { ConnectionManager } from '@/platform/terminal-runtime/ConnectionManager';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { createAttachGate } from '@/platform/terminal-runtime/adapters/TransportAttachGate';
import { detectProfile, PROFILES } from '@/platform/terminal-runtime/DeviceProfile';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { TerminalStatus } from '@/product/terminal/state/session';
import { bannerAtomFamily, bannerAttemptAtomFamily, type ReconnectBanner } from '@/product/terminal/state/ui';
import { useTerminalControlBridge } from '@/product/terminal/hooks/useTerminalControlBridge';

function useSessionEnvSourcing(opts: {
  envRefs: EnvFileRef[];
  sessionId: string;
  effectiveMode: 'p2p' | 'relay';
  agentTerminalApi: TerminalAgentApi | null;
  connectionState: ConnectionState;
}) {
  const { envRefs, sessionId, effectiveMode, agentTerminalApi, connectionState } = opts;
  const envSourcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!envRefs || envRefs.length === 0 || envSourcedRef.current === sessionId) {
      return;
    }
    const apply = () => {
      if (envSourcedRef.current === sessionId) {
        return;
      }
      envSourcedRef.current = sessionId;
      for (const ref of envRefs) {
        void envApi.applySessionEnv(sessionId, [ref]).catch(() => {});
      }
    };
    if (effectiveMode === 'relay') {
      apply();
      return;
    }
    // P2P: env refs are applied once the agent transport is up (the socket
    // being open is the legacy waitForConnection().then(apply) edge).
    if (agentTerminalApi && connectionState === 'connected') {
      apply();
    }
  }, [envRefs, sessionId, effectiveMode, agentTerminalApi, connectionState]);
}

function useTransportFactory(opts: {
  effectiveMode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  agentTerminalApi: TerminalAgentApi | null;
  serverConnection: RelayServerTransport;
  isAttached: () => boolean;
  /** Asked after input is handed over — see `ConnectionOptions.onInputSent`. */
  onInputSent: () => void;
  /**
   * Asked when the stream leaves the buffer with a hole no later replay can
   * fill — see `ConnectionOptions.onStreamTruncated` (#1304).
   */
  onStreamTruncated: () => void;
}) {
  const { effectiveMode, sessionName, sessionId, agentTerminalApi, serverConnection, isAttached, onInputSent, onStreamTruncated } = opts;
  // Holds the render-fresh factory; the callback identity stays stable while
  // the closure sees current values. The ref itself starts null — the
  // previous dummy ConnectionManager initializer was constructed and discarded
  // every render.
  const transportFactoryRef = useRef<(() => TerminalTransport) | null>(null);
  const isAttachedRef = useRef(isAttached);
  isAttachedRef.current = isAttached;
  const onInputSentRef = useRef(onInputSent);
  onInputSentRef.current = onInputSent;
  const onStreamTruncatedRef = useRef(onStreamTruncated);
  onStreamTruncatedRef.current = onStreamTruncated;
  // The P2P transport is a pure I/O channel: ConnectionManager binds to
  // whatever agent terminal API the runtime currently owns (null while no
  // candidate is built — e.g. relay mode — making the transport inert).
  transportFactoryRef.current = () =>
    new ConnectionManager({
      mode: effectiveMode,
      sessionName,
      sessionId,
      agentApi: effectiveMode === 'p2p' ? agentTerminalApi ?? undefined : undefined,
      serverConnection: effectiveMode === 'relay' ? serverConnection : undefined,
      isAttached: () => isAttachedRef.current(),
      // Input is the moment a dead-but-open socket stops being invisible
      // (#1264). Same ref pattern as `isAttached`: the transport reads the
      // runtime as it is *now*, not as it was when this manager was built.
      onInputSent: () => onInputSentRef.current(),
      // And the same for a stream that turned out to have a hole in it
      // (#1304): the runtime is what remembers that a snapshot is owed.
      onStreamTruncated: () => onStreamTruncatedRef.current(),
    });
  return useCallback(() => {
    const createTransport = transportFactoryRef.current;
    if (createTransport === null) {
      throw new Error('Transport factory is not initialized');
    }
    return createTransport();
  }, []);
}

function useReconnectBanner(opts: {
  sessionId: string;
  terminalState: TerminalStatus;
  reconnectCount: number;
  effectiveMode: 'p2p' | 'relay';
  serverConnection: RelayServerHandle;
}): ReconnectBanner {
  const { sessionId, terminalState, reconnectCount, effectiveMode, serverConnection } = opts;
  const setBanner = useSetAtom(bannerAtomFamily(sessionId));
  const setBannerAttempt = useSetAtom(bannerAttemptAtomFamily(sessionId));
  const [relayLost, setRelayLost] = useState(false);

  useEffect(() => {
    setRelayLost(false);
  }, [sessionId, effectiveMode]);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !serverConnection) { return; }
    // UI-only bookkeeping: attach phase transitions are driven by the
    // SessionRuntime relay handler and mirrored through runtime events.
    // Only the durable edges touch relayLost — intra-budget loss shows as
    // 'reconnecting' via the runtime phase mirror (old facade collapsed it
    // onto 'connecting', which this hook ignored too).
    return serverConnection.onConnectionStateChange((state) => {
      if (state === 'connected') {
        setRelayLost(false);
      } else if (state === 'disconnected') {
        setRelayLost(true);
      }
    });
  }, [effectiveMode, serverConnection]);

  const banner: ReconnectBanner =
    terminalState === 'reconnecting'
      ? 'reconnecting'
      : terminalState === 'failed' || relayLost
        ? 'failed'
        : 'none';
  useEffect(() => {
    setBanner(banner);
    setBannerAttempt(reconnectCount);
  }, [banner, reconnectCount, setBanner, setBannerAttempt]);

  return banner;
}

function useEndRelayOnDisconnect(opts: {
  effectiveMode: 'p2p' | 'relay';
  serverConnection: RelayServerHandle;
  sessionId: string;
  onDisconnect: () => void;
}) {
  const { effectiveMode, serverConnection, sessionId, onDisconnect } = opts;
  return useCallback(() => {
    if (effectiveMode === 'relay' && serverConnection?.isReady()) {
      try { serverConnection.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onDisconnect();
  }, [effectiveMode, serverConnection, sessionId, onDisconnect]);
}

export interface UseTerminalOrchestrationOptions {
  onDisconnect: () => void;
  onError: (error: Error) => void;
  rendererType?: 'webgl' | 'canvas';
  scrollbackMode?: 'legacy' | 'local-buffer';
}

export function useTerminalOrchestration({
  onDisconnect,
  onError,
  rendererType = 'canvas',
  scrollbackMode = 'local-buffer',
}: UseTerminalOrchestrationOptions) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [envRefs] = useAtom(envRefsAtom);

  const wsService = useWebSocket();
  // One relay handle per service instance, shared by every relay consumer —
  // the runtime (begin/endRelay + state), the transport factory (relay I/O),
  // the banner, and disconnect cleanup. Rebuilt only when the service does.
  const relayServer = useMemo(() => relayServerHandle(wsService, terminalServerApi), [wsService]);
  // The bootstrap question (#321) is answered by the live Terminal, which does
  // not exist yet at this point in the hook — so the runtime is handed a reader
  // over a ref that the controller assignment below fills in. Reading through a
  // ref is what makes the answer current at *attach* time rather than at the
  // time this closure was built, and the controller outlives every runtime
  // rewire, so there is exactly one authority for it.
  const controllerRef = useRef<TerminalController | null>(null);
  const hasSessionOutput = useCallback(
    () => controllerRef.current?.hasSessionOutput ?? false,
    [],
  );
  const { waitingForAddressPlan, agentTerminalApi, connectionState, runtime, snapshot, fileOps } = useP2PAttachTransport({
    attachInfo,
    sessionName,
    orderedUrls,
    manualOverride,
    serverConnection: relayServer,
    hasSessionOutput,
  });

  // Declared after the runtime exists (the transport factory above only reads
  // it when it is *called*, which is later). Keeps the input path asking the
  // runtime that is current now, not the one that was current at construction
  // (#1264) — the same reason `isAttachedRef` exists.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;

  const { control: terminalControl, takeControl } = useTerminalControlBridge(
    sessionName,
    agentTerminalApi,
  );

  const mirroredAttach = useTerminalAttach({
    sessionId,
    runtime,
  });
  // Runtime snapshot is the protocol source of truth. The attach hook keeps
  // the legacy atom mirror alive for older chrome/components during migration.
  const terminalState = snapshot?.phase ?? mirroredAttach.terminalState;
  const reconnectCount = snapshot?.reconnectCount ?? mirroredAttach.reconnectCount;

  const handleDisconnect = useEndRelayOnDisconnect({
    effectiveMode, serverConnection: relayServer, sessionId, onDisconnect,
  });
  useSessionEnvSourcing({ envRefs, sessionId, effectiveMode, agentTerminalApi, connectionState });
  const transportFactory = useTransportFactory({
    effectiveMode, sessionName, sessionId, agentTerminalApi, serverConnection: relayServer,
    isAttached: createAttachGate(() => terminalState),
    onInputSent: () => runtimeRef.current?.probeLivenessNow(),
    // The session's own record of "my buffer may have a hole", which is what
    // makes the next attach ask for a snapshot (#1304, #321). Reading it
    // through the ref keeps a rewired transport pointing at the live runtime.
    onStreamTruncated: () => runtimeRef.current?.noteStreamTruncated(),
  });
  const [deviceProfile] = useState(() => detectProfile(window.innerWidth));
  const controller = useTerminal({
    sessionId,
    sessionName,
    mode: effectiveMode,
    transportFactory,
    // Canvas avoids WebGL context exhaustion when the viewport remounts during
    // address-plan resolution / StrictMode — lost GL contexts render blank.
    rendererType,
    // Type size, leading and scrollback all come from the device profile, which
    // resolves the first two from the Experience tokens rather than authoring
    // them (terminal-surface.md §Resize and typography).
    fontSize: PROFILES[deviceProfile].fontSize,
    lineHeight: PROFILES[deviceProfile].lineHeight,
    scrollback: PROFILES[deviceProfile].scrollback,
    deviceProfile,
    scrollbackMode,
    runtime,
  });
  // Filled here rather than in an effect: `useTerminal` memoizes the
  // controller, so this is the same instance every render, and an effect would
  // leave the reader answering `false` for the whole first commit — including
  // the viewport's layout-effect attach, which is what starts the first
  // `client.attach` this flag is read by.
  controllerRef.current = controller;

  const banner = useReconnectBanner({
    sessionId, terminalState, reconnectCount, effectiveMode, serverConnection: relayServer,
  });
  const observerReadOnly =
    effectiveMode === 'p2p' && terminalControl.role === 'observer';
  const inputDisabled = banner !== 'none' || isSwitching || observerReadOnly;
  const modeGateOk = !(effectiveMode === 'p2p' && !agentTerminalApi);
  const viewportReady = modeGateOk && !waitingForAddressPlan;
  // Transport rewire epoch. TerminalViewport rebuilds the ConnectionManager
  // whenever this changes, and the manager binds the agent-terminal API the
  // transport factory captures at build time — so the rebuild must never run
  // BEFORE the runtime has swapped its live API, or the fresh transport binds
  // the pre-swap (soon-disposed) socket and the terminal freezes (#668).
  // routeIntentEpoch / transportGeneration change in the same commit whose
  // passive parent effects perform the swap, while (layout) viewport effects
  // run first — keying on either races the swap. The mirrored agentTerminalApi
  // commits only AFTER the swap, so its identity is the safe trigger.
  const [transportEpoch, setTransportEpoch] = useState(0);
  const previousApiRef = useRef(agentTerminalApi);
  useLayoutEffect(() => {
    if (previousApiRef.current === agentTerminalApi) {
      return;
    }
    previousApiRef.current = agentTerminalApi;
    setTransportEpoch((epoch) => epoch + 1);
  }, [agentTerminalApi]);

  useEffect(() => {
    if (!controller) { return; }
    controller.onError = onError;
    controller.onDisconnect = handleDisconnect;
  }, [controller, handleDisconnect, onError]);

  useEffect(() => {
    if (terminalState === 'attached') {
      controller?.flushAllOutbound();
      const seed = runtime?.getP2pStreamSeed?.();
      if (seed) {
        controller?.seedStreamCursor(seed.streamEpoch, seed.streamCursor);
      }
    }
  }, [terminalState, controller, runtime]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    const remoteEnabled = !(effectiveMode === 'p2p' && terminalControl.role === 'observer');
    controller.setRemoteInputEnabled(remoteEnabled);
  }, [controller, effectiveMode, terminalControl.role]);

  return {
    sessionId,
    controller,
    isSwitching,
    waitingForAddressPlan,
    viewportReady,
    inputDisabled,
    terminalState,
    reconnectCount,
    transportEpoch,
    fileOps,
    terminalControl,
    onTakeControl: takeControl,
  };
}
