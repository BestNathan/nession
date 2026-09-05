import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Eye } from 'lucide-react';
import { useAtom } from 'jotai';
import type { AttachInfo, AddressLatency, Session, EnvFileRef } from '../../types';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { AddressSelector } from '../../components/AddressSelector';
import { useWebSocket } from '../../hooks/useWebSocket';
import { relayServerHandle } from '../../runtime/relayServerConnection';
import { useTerminalSessions } from '../../hooks/useTerminalSessions';
import { SessionDropdown } from '../../components/SessionDropdown';
import { TerminalLayout } from '../../components/TerminalLayout';
import { SessionPreviewDialog } from '../../components/SessionPreviewDialog';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  forcedRelayAtom,
  rendererAtom,
} from '../../atoms/session';
import { currentAgentLatenciesAtom } from '../../atoms/probe';
import {
  effectiveModeAtom,
  isSwitchingAtom,
} from '../../atoms/connection';
import { useTerminalOrchestration } from '../../session-first/terminal/useTerminalOrchestration';
import { TerminalPane } from './TerminalPane';

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
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [renderer] = useAtom(rendererAtom);

  const wsService = useWebSocket();
  // Relay cleanup goes through the narrow handle — this component never
  // touches the transport implementation directly.
  const relayServer = useMemo(() => relayServerHandle(wsService), [wsService]);
  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
    refetch: refetchSessions,
  } = useTerminalSessions(wsService);
  const [latencies] = useAtom(currentAgentLatenciesAtom);

  // Preview dialog state
  const [previewOpen, setPreviewOpen] = useState(false);

  // Terminal session state machine: drives client.attach (P2P) / beginRelay
  // (relay), the attach timeout, and the reconnect budget. Returns the live
  // terminalState + reconnectCount so we can render the attempt count reactively.
  const {
    waitingForAddressPlan,
    viewportReady,
    controller,
    terminalState,
    reconnectCount,
    fileOps,
    inputDisabled,
  } = useTerminalOrchestration({
    onDisconnect,
    onError,
    onCtrlD: onBack,
    rendererType: renderer,
    scrollbackMode: 'legacy',
  });

  // End relay synchronously before navigating away, so that the
  // server's relay loop exits and subsequent messages (e.g. sessions.list)
  // are processed by the server handler rather than forwarded to the agent.
  const handleBack = useCallback(() => {
    if (effectiveMode === 'relay' && relayServer?.isReady()) {
      try { relayServer.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onBack();
  }, [effectiveMode, relayServer, sessionId, onBack]);

  const handleGetTerminalPwd = useCallback(async () => {
    if (!fileOps) {throw new Error('File ops not available');}
    return (await fileOps.getCwd(sessionId)).path;
  }, [fileOps, sessionId]);

  const banner: 'none' | 'reconnecting' | 'failed' =
    terminalState === 'reconnecting'
      ? 'reconnecting'
      : terminalState === 'failed'
        ? 'failed'
        : 'none';
  // Keep toolbarDisabled in sync so Input/QuickCommands disable while the
  // terminal is unavailable (mirrors the legacy onBannerChange effect).
  const toolbarDisabled = inputDisabled || banner !== 'none';

  // Wire imperative callbacks the old shell surfaced via <Terminal> props.
  // Flush I/O buffered during the connect window once the session attaches.
  // The transport exists by the time 'attached' fires (TerminalViewport's
  // mount effect creates it — child effects run before this parent effect),
  // so this delivers queued input AND the coalesced resize without waiting
  // for the next user action or ResizeObserver fire.  flushAllOutbound sends
  // input first, then the single latest resize — the agent expects a live
  // session before accepting terminal.* I/O, and this ordering matches.
  const terminalElement = waitingForAddressPlan ? (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  ) : viewportReady ? (
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
