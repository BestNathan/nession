import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { P2PConnection } from '@/services/socket/p2pTypes';
import { useP2PAttachTransport } from '@/hooks/useP2PAttachTransport';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { EnvFileRef } from '@/types';
import type { WebSocketService } from '@/services/websocket';
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
  p2pEpochAtom,
} from '@/atoms/connection';
import { useTerminal } from '@/terminal/hooks/useTerminal';
import { useSessionFirstTerminalAttach } from '@/session-first/terminal/useSessionFirstTerminalAttach';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import { createAttachGate } from '@/terminal/adapters/TransportAttachGate';
import { detectProfile, PROFILES } from '@/terminal/DeviceProfile';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';
import { terminalSessionStateAtom, type TerminalStatus } from '@/terminal/state/session';
import { bannerAtomFamily, bannerAttemptAtomFamily, type ReconnectBanner } from '@/terminal/state/ui';

function useSessionEnvSourcing(opts: {
  envRefs: EnvFileRef[];
  sessionId: string;
  effectiveMode: 'p2p' | 'relay';
  p2pConnection: P2PConnection | null;
  wsService: WebSocketService;
}) {
  const { envRefs, sessionId, effectiveMode, p2pConnection, wsService } = opts;
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
        void wsService.applySessionEnv(sessionId, [ref]).catch(() => {});
      }
    };
    if (effectiveMode === 'relay') {
      apply();
      return;
    }
    if (p2pConnection) {
      void p2pConnection.waitForConnection().then(apply).catch(() => {});
    }
  }, [envRefs, sessionId, effectiveMode, p2pConnection, wsService]);
}

function useTransportFactory(opts: {
  effectiveMode: 'p2p' | 'relay';
  sessionName: string;
  sessionId: string;
  p2pConnection: P2PConnection | null;
  wsService: WebSocketService;
  isAttached: () => boolean;
}) {
  const { effectiveMode, sessionName, sessionId, p2pConnection, wsService, isAttached } = opts;
  const transportFactoryRef = useRef<() => TerminalTransport>(
    () => new ConnectionManager({
      mode: 'relay', sessionName: '', sessionId: '', serverConnection: undefined,
    }) as unknown as TerminalTransport,
  );
  const isAttachedRef = useRef(isAttached);
  isAttachedRef.current = isAttached;
  transportFactoryRef.current = () =>
    new ConnectionManager({
      mode: effectiveMode,
      sessionName,
      sessionId,
      p2pConnection: effectiveMode === 'p2p' ? p2pConnection ?? undefined : undefined,
      serverConnection: effectiveMode === 'relay' ? wsService : undefined,
      isAttached: () => isAttachedRef.current(),
    }) as unknown as TerminalTransport;
  return useCallback(() => transportFactoryRef.current(), []);
}

function useReconnectBanner(opts: {
  sessionId: string;
  terminalState: TerminalStatus;
  reconnectCount: number;
  effectiveMode: 'p2p' | 'relay';
  wsService: WebSocketService;
}): ReconnectBanner {
  const { sessionId, terminalState, reconnectCount, effectiveMode, wsService } = opts;
  const setTerminalState = useSetAtom(terminalSessionStateAtom);
  const setBanner = useSetAtom(bannerAtomFamily(sessionId));
  const setBannerAttempt = useSetAtom(bannerAttemptAtomFamily(sessionId));
  const [relayLost, setRelayLost] = useState(false);

  useEffect(() => {
    setRelayLost(false);
  }, [sessionId, effectiveMode]);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !wsService) { return; }
    return wsService.onConnectionChange((status) => {
      if (status === 'authenticated') {
        setRelayLost(false);
        setTerminalState((prev) => {
          if (prev === 'connecting' || prev === 'reconnecting' || prev === 'failed') {
            return 'connecting';
          }
          return prev;
        });
      } else if (status === 'disconnected') {
        setRelayLost(true);
      }
    });
  }, [effectiveMode, wsService, setTerminalState]);

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
  wsService: WebSocketService;
  sessionId: string;
  onDisconnect: () => void;
}) {
  const { effectiveMode, wsService, sessionId, onDisconnect } = opts;
  return useCallback(() => {
    if (effectiveMode === 'relay' && wsService?.isConnected()) {
      try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onDisconnect();
  }, [effectiveMode, wsService, sessionId, onDisconnect]);
}

export interface UseTerminalOrchestrationOptions {
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

export function useTerminalOrchestration({
  onDisconnect,
  onError,
}: UseTerminalOrchestrationOptions) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [envRefs] = useAtom(envRefsAtom);
  const p2pEpoch = useAtomValue(p2pEpochAtom);

  const wsService = useWebSocket();
  const { waitingForAddressPlan, p2pConnection, activeUrl } = useP2PAttachTransport({
    attachInfo,
    sessionName,
    orderedUrls,
    manualOverride,
    transportFirst: true,
  });

  const { terminalState, reconnectCount } = useSessionFirstTerminalAttach({
    sessionId,
    sessionName,
    p2pConnection,
    wsService,
  });

  const handleDisconnect = useEndRelayOnDisconnect({
    effectiveMode, wsService, sessionId, onDisconnect,
  });
  useSessionEnvSourcing({ envRefs, sessionId, effectiveMode, p2pConnection, wsService });
  const transportFactory = useTransportFactory({
    effectiveMode, sessionName, sessionId, p2pConnection, wsService,
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
    rendererType: 'canvas',
    fontSize: PROFILES[deviceProfile].fontSize,
    scrollback: PROFILES[deviceProfile].scrollback,
    deviceProfile,
    scrollbackMode: 'local-buffer',
  });

  const banner = useReconnectBanner({
    sessionId, terminalState, reconnectCount, effectiveMode, wsService,
  });
  const inputDisabled = banner !== 'none' || isSwitching;
  const modeGateOk = !(effectiveMode === 'p2p' && !p2pConnection);
  const viewportReady = modeGateOk && !waitingForAddressPlan;
  const transportKey = `${p2pEpoch}:${activeUrl ?? ''}`;

  useEffect(() => {
    if (!controller) { return; }
    controller.onCtrlD = handleDisconnect;
    controller.onError = onError;
    controller.onDisconnect = handleDisconnect;
  }, [controller, handleDisconnect, onError]);

  useEffect(() => {
    if (terminalState === 'attached') {
      controller?.flushAllOutbound();
    }
  }, [terminalState, controller]);

  return {
    sessionId,
    controller,
    isSwitching,
    inputDisabled,
    viewportReady,
    terminalState,
    reconnectCount,
    transportKey,
  };
}
