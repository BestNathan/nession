import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Eye } from 'lucide-react';
import { useAtom, useSetAtom } from 'jotai';
import type { AttachInfo, AddressLatency, Session, EnvFileRef } from '../../types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useP2PAttachTransport } from '../../hooks/useP2PAttachTransport';
import { createAttachGate } from '../adapters/TransportAttachGate';
import { AddressSelector } from '../../components/AddressSelector';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useTerminalSessions } from '../../hooks/useTerminalSessions';
import { SessionDropdown } from '../../components/SessionDropdown';
import { TerminalLayout } from '../../components/TerminalLayout';
import { SessionPreviewDialog } from '../../components/SessionPreviewDialog';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  forcedRelayAtom,
  rendererAtom,
  envRefsAtom,
} from '../../atoms/session';
import { currentAgentLatenciesAtom } from '../../atoms/probe';
import {
  effectiveModeAtom,
  isSwitchingAtom,
} from '../../atoms/connection';
import { useTerminal } from '../hooks/useTerminal';
import { useTerminalStateMachine } from '../hooks/useTerminalStateMachine';
import { ConnectionManager } from '../ConnectionManager';
import { detectProfile, PROFILES } from '../DeviceProfile';
import type { TerminalTransport } from '../transport/TerminalTransport';
import { TerminalPane } from './TerminalPane';
import { terminalSessionStateAtom } from '../state/session';
import { bannerAtomFamily, bannerAttemptAtomFamily, type ReconnectBanner } from '../state/ui';

interface TerminalHeaderProps {
  onBack: () => void;
  sessionName: string;
  effectiveMode: 'p2p' | 'relay';
  attachInfo: AttachInfo | null;
  forcedRelay: boolean;
  latencies?: AddressLatency[];
  // NEW — session list data for the dropdown
  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  onRetrySessions: () => void;
}

function TerminalHeader({
  onBack, sessionName, effectiveMode,
  attachInfo, forcedRelay, latencies,
  sessions, sessionsLoading, sessionsError, onRetrySessions,
  onPreview,
}: TerminalHeaderProps & { onPreview: () => void }) {
  // Detect mobile viewport (sm breakpoint = 640px)
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <header className="border-b px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-4 flex-shrink-0 flex-wrap">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>
      <SessionDropdown
        sessions={sessions}
        loading={sessionsLoading}
        error={sessionsError}
        onRetry={onRetrySessions}
        currentSessionName={sessionName}
      />
      <Badge variant={effectiveMode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
        {effectiveMode.toUpperCase()}
        {forcedRelay && attachInfo?.mode === 'p2p' ? ' (fallback)' : ''}
      </Badge>
      {attachInfo && attachInfo.mode === 'p2p' && attachInfo.addresses ? (
        <AddressSelector
          addresses={attachInfo.addresses}
          latencies={latencies ?? []}
          effectiveMode={effectiveMode}
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="outline" size="sm" onClick={onPreview}>
            <Eye className="w-4 h-4 sm:mr-1" />
            {!isMobile && 'Preview'}
          </Button>
        }>
          Preview recent scrollback
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>View recent terminal output</p>
        </TooltipContent>
      </Tooltip>
    </header>
  );
}

/**
 * Shell attach descriptor for deep-link restoration. Dashboard derives this
 * from the jotai atoms and passes it to useDeepLinkRestore; TerminalView itself
 * no longer consumes it — all session state now lives in atoms.
 */
export interface AttachedSession {
  attachInfo: AttachInfo;
  sessionId: string;
  sessionName: string;
  orderedUrls?: string[];
  latencies?: AddressLatency[];
  selectedAddress?: string;
  /** Manual relay endpoint URL from the attach dialog (null = auto). */
  relayUrl?: string | null;
  renderer?: 'webgl' | 'canvas';
  /** Env files chosen in the attach dialog to source once the terminal is live. */
  envRefs?: EnvFileRef[];
}

interface TerminalWorkspaceProps {
  onBack: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

export function TerminalWorkspace({ onBack, onDisconnect, onError }: TerminalWorkspaceProps) {
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [attachInfo] = useAtom(attachInfoAtom);
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [forcedRelay] = useAtom(forcedRelayAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [orderedUrls] = useAtom(orderedUrlsAtom);
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [renderer] = useAtom(rendererAtom);
  const [envRefs] = useAtom(envRefsAtom);

  const wsService = useWebSocket();
  const setTerminalState = useSetAtom(terminalSessionStateAtom);
  const setBanner = useSetAtom(bannerAtomFamily(sessionId));
  const setBannerAttempt = useSetAtom(bannerAttemptAtomFamily(sessionId));
  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
    refetch: refetchSessions,
  } = useTerminalSessions(wsService);
  const [latencies] = useAtom(currentAgentLatenciesAtom);

  const isP2P = effectiveMode === 'p2p';

  const { waitingForAddressPlan, p2pConnection, p2pState, fileOps } = useP2PAttachTransport({
    attachInfo,
    sessionName,
    orderedUrls,
    manualOverride,
    transportFirst: false,
  });

  // Preview dialog state
  const [previewOpen, setPreviewOpen] = useState(false);

  // Terminal session state machine: drives client.attach (P2P) / beginRelay
  // (relay), the attach timeout, and the reconnect budget. Returns the live
  // terminalState + reconnectCount so we can render the attempt count reactively.
  const { terminalState, reconnectCount } = useTerminalStateMachine({
    serverConnection: !isP2P ? wsService : undefined,
    p2pConnection,
    p2pState,
  });

  // End relay synchronously before navigating away, so that the
  // server's relay loop exits and subsequent messages (e.g. sessions.list)
  // are processed by the server handler rather than forwarded to the agent.
  const handleBack = useCallback(() => {
    if (effectiveMode === 'relay' && wsService?.isConnected()) {
      try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onBack();
  }, [effectiveMode, wsService, sessionId, onBack]);

  // Source env files selected in the attach dialog once the session transport
  // is live. applySessionEnv routes through the server to the agent's tmux, so
  // relay mode can fire immediately; P2P waits for the socket to come up.
  // Guarded per sessionId so StrictMode's double-mount or re-renders can't
  // re-apply, while switching to a different session sources fresh.
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

  const handleGetTerminalPwd = useCallback(async () => {
    if (!fileOps) {throw new Error('File ops not available');}
    return (await fileOps.getCwd(sessionId)).path;
  }, [fileOps, sessionId]);

  // ── Terminal transport boundary ─────────────────────────────────────
  // Wrap ConnectionManager into the TerminalTransport shape the controller
  // expects. The factory must close over LIVE values (p2pConnection /
  // wsService / sessionName change without recreating the controller), so we
  // reassign it every render but expose a stable useCallback wrapper — the
  // controller, and therefore the xterm view, never rebuilds from a changing
  // factory identity.
  const transportFactoryRef = useRef<() => TerminalTransport>(
    () => new ConnectionManager({
      mode: 'relay', sessionName: '', sessionId: '', serverConnection: undefined,
    }),
  );
  const isAttachedRef = useRef(createAttachGate(() => terminalState));
  isAttachedRef.current = createAttachGate(() => terminalState);
  transportFactoryRef.current = () =>
    new ConnectionManager({
      mode: effectiveMode,
      sessionName,
      sessionId,
      p2pConnection: effectiveMode === 'p2p' ? p2pConnection ?? undefined : undefined,
      serverConnection: effectiveMode === 'relay' ? wsService : undefined,
      isAttached: () => isAttachedRef.current(),
    });
  const transportFactory = useCallback(() => transportFactoryRef.current(), []);

  // One controller per session/mode — stable across terminalState transitions
  // so the xterm view isn't torn down on every re-render.
  // Device profile (font size / scrollback) is computed once at mount, matching
  // the legacy Terminal.tsx behaviour of sizing the terminal from the viewport
  // at attach time. Keeping it in state (not recomputed per render) prevents a
  // breakpoint-crossing resize from tearing down and rebuilding xterm.
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
    scrollbackMode: 'legacy',
  });

  // Issue #51: never mount xterm in P2P mode before the socket exists —
  // xterm's Viewport crashes on an unattached container, and a ConnectionManager
  // created without a live p2pConnection would be inert forever (the transport
  // is built once at attach). Relay mode is always safe to mount.
  const modeGateOk = !(effectiveMode === 'p2p' && !p2pConnection);

  // ── Relay-mode server-ws lifecycle ───────────────────────────────────
  // The state machine's P2P bridge covers socket drops only; in relay mode the
  // server WebSocket dropping must mirror the legacy view.onStateChange path:
  // show the "Connection lost" banner once the server ws exhausts its reconnect
  // budget, clear it (and let the state machine re-beginRelay) on re-auth.
  const [relayLost, setRelayLost] = useState(false);
  useEffect(() => {
    if (effectiveMode !== 'relay' || !wsService) { return; }
    return wsService.onConnectionChange((status) => {
      if (status === 'authenticated') {
        setRelayLost(false);
        // Server ws authenticated after TerminalWorkspace mounted (rare — the
        // state machine's 'connecting' branch handles the already-authed case
        // via isConnected()). Hand off so beginRelay is actually sent.
        setTerminalState((prev) => {
          if (prev === 'connecting' || prev === 'reconnecting' || prev === 'failed') {
            return 'connected';
          }
          return prev;
        });
      } else if (status === 'disconnected') {
        setRelayLost(true);
        setTerminalState((prev) => {
          if (prev === 'attached' || prev === 'connected') {
            return 'reconnecting';
          }
          return prev;
        });
      }
    });
  }, [effectiveMode, wsService, setTerminalState]);

  // ── Banner ───────────────────────────────────────────────────────────
  // Map the (P2P-driven) state machine + relay-lost flag onto the banner atoms
  // TerminalPane's TerminalBanner consumes.
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

  // Keep toolbarDisabled in sync so Input/QuickCommands disable while the
  // terminal is unavailable (mirrors the legacy onBannerChange effect).
  const toolbarDisabled = banner !== 'none';

  // Wire imperative callbacks the old shell surfaced via <Terminal> props.
  useEffect(() => {
    if (!controller) { return; }
    controller.onCtrlD = onBack;
    controller.onError = onError;
    controller.onDisconnect = onDisconnect;
  }, [controller, onBack, onError, onDisconnect]);

  // Flush I/O buffered during the connect window once the session attaches.
  // The transport exists by the time 'attached' fires (TerminalViewport's
  // mount effect creates it — child effects run before this parent effect),
  // so this delivers queued input AND the coalesced resize without waiting
  // for the next user action or ResizeObserver fire.  flushAllOutbound sends
  // input first, then the single latest resize — the agent expects a live
  // session before accepting terminal.* I/O, and this ordering matches.
  useEffect(() => {
    if (terminalState === 'attached') {
      controller?.flushAllOutbound();
    }
  }, [terminalState, controller]);

  const terminalElement = waitingForAddressPlan ? (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  ) : modeGateOk ? (
    <TerminalPane sessionId={sessionId} controller={controller} reconnectAttempt={reconnectCount} />
  ) : (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="h-[100dvh] flex flex-col bg-background">
      <TerminalHeader
        onBack={handleBack}
        sessionName={sessionName}
        effectiveMode={effectiveMode}
        attachInfo={attachInfo}
        forcedRelay={forcedRelay}
        latencies={latencies}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionsError={sessionsError}
        onRetrySessions={refetchSessions}
        onPreview={() => setPreviewOpen(true)}
      />

      <SessionPreviewDialog
        isOpen={previewOpen}
        onClose={() => setPreviewOpen(false)}
        sessionId={sessionId}
        sessionName={sessionName}
      />

      <div className="flex-1 min-h-0 flex flex-col relative">
        {isSwitching && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm pointer-events-auto">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        )}
        <TerminalLayout
          terminalElement={terminalElement}
          sessionId={sessionId}
          sessionName={sessionName}
          sendText={(text) => {
            if (banner === 'none') { controller?.send(text); }
          }}
          onScrollPages={(pages) => controller?.scrollPages(pages)}
          onScrollToBottom={() => controller?.scrollToBottom()}
          toolbarDisabled={toolbarDisabled}
          fileOps={fileOps}
          onTerminalReveal={() => {}}
          fontSizeManager={controller?.fontSizeManager ?? null}
          onGetTerminalPwd={fileOps ? handleGetTerminalPwd : undefined}
          controller={controller}
        />
      </div>
    </div>
  );
}
