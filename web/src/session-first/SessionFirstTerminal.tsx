import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAtom, useSetAtom } from 'jotai';
import { cn } from '@/lib/utils';
import { useP2PConnection, type P2PConnection } from '@/hooks/useP2PConnection';
import { useAddressPlan } from '@/hooks/useAddressPlan';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { EnvFileRef } from '@/types';
import type { WebSocketService } from '@/services/websocket';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  rendererAtom,
  envRefsAtom,
} from '@/atoms/session';
import {
  effectiveModeAtom,
  isSwitchingAtom,
  p2pConnectionAtom,
} from '@/atoms/connection';
import { useTerminal } from '@/terminal/hooks/useTerminal';
import { useTerminalStateMachine } from '@/terminal/hooks/useTerminalStateMachine';
import { ConnectionManager } from '@/terminal/ConnectionManager';
import { detectProfile, PROFILES } from '@/terminal/DeviceProfile';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';
import type { TerminalController } from '@/terminal/controller/TerminalController';
import { TerminalPane } from '@/terminal/components/TerminalPane';
import { terminalSessionStateAtom, type TerminalStatus } from '@/terminal/state/session';
import { bannerAtomFamily, bannerAttemptAtomFamily, type ReconnectBanner } from '@/terminal/state/ui';

export interface SessionFirstTerminalProps {
  hidden: boolean;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

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
}) {
  const { effectiveMode, sessionName, sessionId, p2pConnection, wsService } = opts;
  const transportFactoryRef = useRef<() => TerminalTransport>(
    () => new ConnectionManager({
      mode: 'relay', sessionName: '', sessionId: '', serverConnection: undefined,
    }) as unknown as TerminalTransport,
  );
  transportFactoryRef.current = () =>
    new ConnectionManager({
      mode: effectiveMode,
      sessionName,
      sessionId,
      p2pConnection: effectiveMode === 'p2p' ? p2pConnection ?? undefined : undefined,
      serverConnection: effectiveMode === 'relay' ? wsService : undefined,
    }) as unknown as TerminalTransport;
  return useCallback(() => transportFactoryRef.current(), []);
}

function useReconnectBanner(opts: {
  sessionId: string;
  terminalState: TerminalStatus;
  reconnectCount: number;
  effectiveMode: 'p2p' | 'relay';
  wsService: WebSocketService;
}) {
  const { sessionId, terminalState, reconnectCount, effectiveMode, wsService } = opts;
  const setTerminalState = useSetAtom(terminalSessionStateAtom);
  const setBanner = useSetAtom(bannerAtomFamily(sessionId));
  const setBannerAttempt = useSetAtom(bannerAttemptAtomFamily(sessionId));
  const [relayLost, setRelayLost] = useState(false);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !wsService) { return; }
    return wsService.onConnectionChange((status) => {
      if (status === 'authenticated') {
        setRelayLost(false);
        setTerminalState((prev) => (prev === 'connecting' ? 'connected' : prev));
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

function SwitchingOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm pointer-events-auto">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function KeepAliveSurface({ isSwitching, children }: { isSwitching: boolean; children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {isSwitching && <SwitchingOverlay />}
      {children}
    </div>
  );
}

function terminalBody(opts: {
  waitingForAddressPlan: boolean;
  modeGateOk: boolean;
  sessionId: string;
  controller: TerminalController | null;
  reconnectCount: number;
}) {
  if (opts.waitingForAddressPlan) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (opts.modeGateOk) {
    return (
      <TerminalPane
        sessionId={opts.sessionId}
        controller={opts.controller}
        reconnectAttempt={opts.reconnectCount}
      />
    );
  }
  return <div className="flex-1 min-h-0" />;
}

export function SessionFirstTerminal({ hidden, onDisconnect, onError }: SessionFirstTerminalProps) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [renderer] = useAtom(rendererAtom);
  const [envRefs] = useAtom(envRefsAtom);
  const [p2pConnection] = useAtom(p2pConnectionAtom);

  const wsService = useWebSocket();
  const isP2P = effectiveMode === 'p2p';
  const addressPlan = useAddressPlan(attachInfo, {
    orderedUrls,
    manualUrl: manualOverride,
  });
  const activeUrl = addressPlan.ready ? addressPlan.urls[0] ?? null : null;

  useP2PConnection(
    isP2P && activeUrl && attachInfo && addressPlan.ready
      ? {
          agentUrl: activeUrl,
          connectionToken: attachInfo.connection_token,
          sessionName,
          maxReconnectAttempts: manualOverride ? 2 : 10,
        }
      : null,
  );

  const { terminalState, reconnectCount } = useTerminalStateMachine({
    serverConnection: !isP2P ? wsService : undefined,
  });

  const handleDisconnect = useEndRelayOnDisconnect({
    effectiveMode, wsService, sessionId, onDisconnect,
  });
  useSessionEnvSourcing({ envRefs, sessionId, effectiveMode, p2pConnection, wsService });
  const transportFactory = useTransportFactory({
    effectiveMode, sessionName, sessionId, p2pConnection, wsService,
  });
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
  });

  useReconnectBanner({ sessionId, terminalState, reconnectCount, effectiveMode, wsService });

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

  return (
    <div
      data-testid="session-first-terminal"
      className={cn('flex-1 min-h-0 flex flex-col', hidden && 'hidden')}
    >
      {!sessionId ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">
          Select a session
        </div>
      ) : (
        <KeepAliveSurface isSwitching={isSwitching}>
          {terminalBody({
            waitingForAddressPlan: isP2P && !addressPlan.ready,
            modeGateOk: !(effectiveMode === 'p2p' && !p2pConnection),
            sessionId,
            controller,
            reconnectCount,
          })}
        </KeepAliveSurface>
      )}
    </div>
  );
}
