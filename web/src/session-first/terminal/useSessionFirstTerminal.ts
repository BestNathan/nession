import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { P2PConnection } from '@/hooks/useP2PConnection';
import { useP2PAttachTransport } from '@/hooks/useP2PAttachTransport';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { EnvFileRef } from '@/types';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  rendererAtom,
  envRefsAtom,
} from '@/atoms/session';
import { effectiveModeAtom, isSwitchingAtom } from '@/atoms/connection';
import { useTerminal } from '@/terminal/hooks/useTerminal';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import { detectProfile, PROFILES } from '@/terminal/DeviceProfile';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';
import { bannerAtomFamily, bannerAttemptAtomFamily, type ReconnectBanner } from '@/terminal/state/ui';
import { useSessionFirstTerminalAttach } from '@/session-first/terminal/useSessionFirstTerminalAttach';

function useSessionEnvSourcing(opts: {
  envRefs: EnvFileRef[];
  sessionId: string;
  effectiveMode: 'p2p' | 'relay';
  p2pConnection: P2PConnection | null;
  wsService: ReturnType<typeof useWebSocket>;
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

export interface UseSessionFirstTerminalOptions {
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

/**
 * Session-first terminal stack — dedicated attach lifecycle (transport before
 * protocol). Reuses xterm/ConnectionManager/WebSocketService; does NOT use the
 * shared useTerminalStateMachine (legacy dashboard path keeps that).
 */
export function useSessionFirstTerminal({
  onDisconnect,
  onError,
}: UseSessionFirstTerminalOptions) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [renderer] = useAtom(rendererAtom);
  const [envRefs] = useAtom(envRefsAtom);

  const wsService = useWebSocket();
  const setBanner = useSetAtom(bannerAtomFamily(sessionId));
  const setBannerAttempt = useSetAtom(bannerAttemptAtomFamily(sessionId));

  const { waitingForAddressPlan, p2pConnection, p2pState, runtime } = useP2PAttachTransport({
    attachInfo,
    sessionName,
    orderedUrls,
    manualOverride,
  });

  const { terminalState, reconnectCount } = useSessionFirstTerminalAttach({
    sessionId,
    sessionName,
    p2pConnection,
    p2pState,
    wsService,
    runtime,
  });

  const transportFactoryRef = useRef<() => TerminalTransport>(
    () => new ConnectionManager({
      mode: 'relay', sessionName: '', sessionId: '', serverConnection: undefined,
    }),
  );
  transportFactoryRef.current = () =>
    new ConnectionManager({
      mode: effectiveMode,
      sessionName,
      sessionId,
      p2pConnection: effectiveMode === 'p2p' ? p2pConnection ?? undefined : undefined,
      serverConnection: effectiveMode === 'relay' ? wsService : undefined,
    });
  const transportFactory = useCallback(() => transportFactoryRef.current(), []);

  const [deviceProfile] = useState(() => detectProfile(window.innerWidth));
  const controller = useTerminal({
    sessionId,
    sessionName,
    mode: effectiveMode,
    transportFactory,
    rendererType: renderer,
    fontSize: PROFILES[deviceProfile].fontSize,
    scrollback: PROFILES[deviceProfile].scrollback,
    deviceProfile,
    scrollbackMode: 'local-buffer',
  });

  useSessionEnvSourcing({ envRefs, sessionId, effectiveMode, p2pConnection, wsService });

  const [relayLost, setRelayLost] = useState(false);
  useEffect(() => {
    setRelayLost(false);
  }, [sessionId, effectiveMode]);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !wsService) { return; }
    return wsService.onConnectionChange((status) => {
      if (status === 'authenticated') {
        setRelayLost(false);
      } else if (status === 'disconnected') {
        setRelayLost(true);
      }
    });
  }, [effectiveMode, wsService]);

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

  const handleDisconnect = useCallback(() => {
    if (effectiveMode === 'relay' && wsService?.isConnected()) {
      try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onDisconnect();
  }, [effectiveMode, wsService, sessionId, onDisconnect]);

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

  const socketReady = effectiveMode === 'relay' || Boolean(p2pConnection);
  const viewportReady = socketReady && !waitingForAddressPlan;

  return {
    sessionId,
    controller,
    isSwitching,
    inputDisabled: banner !== 'none' || isSwitching,
    viewportReady,
    terminalState,
  };
}
