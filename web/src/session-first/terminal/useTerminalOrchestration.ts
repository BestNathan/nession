import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import { useP2PAttachTransport } from '@/hooks/useP2PAttachTransport';
import { useWebSocket } from '@/hooks/useWebSocket';
import { envApi } from '@/features/env';
import {
  relayServerHandle,
  type RelayServerHandle,
  type RelayServerTransport,
} from '@/runtime/relayServerConnection';
import type { EnvFileRef } from '@/types';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  envRefsAtom,
} from '@/atoms/session';
import {
  effectiveModeAtom,
  isSwitchingAtom,
  routeIntentEpochAtom,
  transportGenerationAtom,
} from '@/atoms/connection';
import { useTerminal } from '@/terminal/hooks/useTerminal';
import { useSessionFirstTerminalAttach } from '@/session-first/terminal/useSessionFirstTerminalAttach';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import { createAttachGate } from '@/terminal/adapters/TransportAttachGate';
import { detectProfile, PROFILES } from '@/terminal/DeviceProfile';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';
import type { TerminalStatus } from '@/terminal/state/session';
import { bannerAtomFamily, bannerAttemptAtomFamily, type ReconnectBanner } from '@/terminal/state/ui';

function useSessionEnvSourcing(opts: {
  envRefs: EnvFileRef[];
  sessionId: string;
  effectiveMode: 'p2p' | 'relay';
  p2pConnection: P2PConnection | null;
}) {
  const { envRefs, sessionId, effectiveMode, p2pConnection } = opts;
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
    if (p2pConnection) {
      void p2pConnection.waitForConnection().then(apply).catch(() => {});
    }
  }, [envRefs, sessionId, effectiveMode, p2pConnection]);
}

function useTransportFactory(opts: {
  effectiveMode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  p2pConnection: P2PConnection | null;
  serverConnection: RelayServerTransport;
  isAttached: () => boolean;
}) {
  const { effectiveMode, sessionName, sessionId, p2pConnection, serverConnection, isAttached } = opts;
  const transportFactoryRef = useRef<() => TerminalTransport>(
    () => new ConnectionManager({
      mode: 'relay', sessionName: '', sessionId: '', serverConnection: undefined,
    }),
  );
  const isAttachedRef = useRef(isAttached);
  isAttachedRef.current = isAttached;
  transportFactoryRef.current = () =>
    new ConnectionManager({
      mode: effectiveMode,
      sessionName,
      sessionId,
      p2pConnection: effectiveMode === 'p2p' ? p2pConnection ?? undefined : undefined,
      serverConnection: effectiveMode === 'relay' ? serverConnection : undefined,
      isAttached: () => isAttachedRef.current(),
    });
  return useCallback(() => transportFactoryRef.current(), []);
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
  /** UI-specific Ctrl-D behavior; transport disconnect stays shared. */
  onCtrlD?: () => void;
  rendererType?: 'webgl' | 'canvas';
  scrollbackMode?: 'legacy' | 'local-buffer';
}

export function useTerminalOrchestration({
  onDisconnect,
  onError,
  onCtrlD,
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
  const routeIntentEpoch = useAtomValue(routeIntentEpochAtom);
  const transportGeneration = useAtomValue(transportGenerationAtom);

  const wsService = useWebSocket();
  // One relay handle per service instance, shared by every relay consumer —
  // the runtime (begin/endRelay + state), the transport factory (relay I/O),
  // the banner, and disconnect cleanup. Rebuilt only when the service does.
  const relayServer = useMemo(() => relayServerHandle(wsService), [wsService]);
  const { waitingForAddressPlan, p2pConnection, activeUrl, runtime, snapshot, fileOps, transportKey: runtimeTransportKey } = useP2PAttachTransport({
    attachInfo,
    sessionName,
    orderedUrls,
    manualOverride,
    transportFirst: true,
    serverConnection: relayServer,
  });

  const mirroredAttach = useSessionFirstTerminalAttach({
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
  useSessionEnvSourcing({ envRefs, sessionId, effectiveMode, p2pConnection });
  const transportFactory = useTransportFactory({
    effectiveMode, sessionName, sessionId, p2pConnection, serverConnection: relayServer,
    isAttached: createAttachGate(() => terminalState),
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
    fontSize: PROFILES[deviceProfile].fontSize,
    scrollback: PROFILES[deviceProfile].scrollback,
    deviceProfile,
    scrollbackMode,
    runtime,
  });

  const banner = useReconnectBanner({
    sessionId, terminalState, reconnectCount, effectiveMode, serverConnection: relayServer,
  });
  const inputDisabled = banner !== 'none' || isSwitching;
  const modeGateOk = !(effectiveMode === 'p2p' && !p2pConnection);
  const viewportReady = modeGateOk && !waitingForAddressPlan;
  const transportKey = runtimeTransportKey ?? `${routeIntentEpoch}:${transportGeneration}:${activeUrl ?? ''}`;

  useEffect(() => {
    if (!controller) { return; }
    controller.onCtrlD = onCtrlD ?? handleDisconnect;
    controller.onError = onError;
    controller.onDisconnect = handleDisconnect;
  }, [controller, handleDisconnect, onCtrlD, onError]);

  useEffect(() => {
    if (terminalState === 'attached') {
      controller?.flushAllOutbound();
    }
  }, [terminalState, controller]);

  return {
    sessionId,
    controller,
    isSwitching,
    waitingForAddressPlan,
    viewportReady,
    inputDisabled,
    terminalState,
    reconnectCount,
    transportKey,
    fileOps,
  };
}
