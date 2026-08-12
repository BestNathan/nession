import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useAtom } from 'jotai';
import type { AttachInfo, AddressLatency, Session, EnvFileRef } from '../../types';
import { Terminal, type TerminalHandle } from '../../components/Terminal';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useP2PConnection } from '../../hooks/useP2PConnection';
import { createFileOps } from '../../services/fileOps';
import { AddressSelector } from '../../components/AddressSelector';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useTerminalSessions } from '../../hooks/useTerminalSessions';
import { SessionDropdown } from '../../components/SessionDropdown';
import { TerminalLayout } from '../../components/TerminalLayout';
import {
  sessionIdAtom,
  sessionNameAtom,
  attachInfoAtom,
  manualOverrideAtom,
  forcedRelayAtom,
  rendererAtom,
  envRefsAtom,
} from '../../atoms/session';
import { currentAgentLatenciesAtom } from '../../atoms/probe';
import {
  activeUrlAtom,
  effectiveModeAtom,
  isSwitchingAtom,
  p2pConnectionAtom,
} from '../../atoms/connection';

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
}: TerminalHeaderProps) {
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
  const [activeUrl] = useAtom(activeUrlAtom);
  const [forcedRelay] = useAtom(forcedRelayAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [isSwitching] = useAtom(isSwitchingAtom);
  const [renderer] = useAtom(rendererAtom);
  const [envRefs] = useAtom(envRefsAtom);
  const [p2pConnection] = useAtom(p2pConnectionAtom);

  const wsService = useWebSocket();
  // Callback ref backed by state so the parent re-renders when the child
  // populates the imperative handle. Without this, `fontSizeManager` on
  // the handle would stay null on first render and the zoom controls
  // would never mount. See docs/.../fixed-size-terminal spec.
  const [terminalHandle, setTerminalHandle] = useState<TerminalHandle | null>(null);
  const terminalRef = useCallback((handle: TerminalHandle | null) => {
    setTerminalHandle(handle);
  }, []);
  const [toolbarDisabled, setToolbarDisabled] = useState(false);
  const {
    sessions,
    loading: sessionsLoading,
    error: sessionsError,
    refetch: refetchSessions,
  } = useTerminalSessions(wsService);
  const [latencies] = useAtom(currentAgentLatenciesAtom);

  const isP2P = effectiveMode === 'p2p';

  // Drive the P2P WebSocket. useP2PConnection writes p2pConnectionAtom +
  // p2pStateAtom from its ws events, and we read them back below (Terminal
  // subscribes to sessionIdAtom/sessionNameAtom/effectiveModeAtom/
  // p2pConnectionAtom directly). The options are derived purely from atoms:
  // activeUrl (manual override or best candidate) is the endpoint, forcedRelay
  // flips effectiveMode to relay which nulls activeUrl.
  useP2PConnection(
    isP2P && activeUrl && attachInfo
      ? {
          agentUrl: activeUrl,
          connectionToken: attachInfo.connection_token,
          sessionName,
          // A manual address fails fast (2 attempts) — the user picked it, so
          // there's nothing to rotate to. Auto candidates get the full backoff
          // budget so a flaky-but-working endpoint gets a fair chance.
          maxReconnectAttempts: manualOverride ? 2 : 10,
        }
      : null,
  );

  // End relay synchronously before navigating away, so that the
  // server's relay loop exits and subsequent messages (e.g. sessions.list)
  // are processed by the server handler rather than forwarded to the agent.
  const handleBack = useCallback(() => {
    if (effectiveMode === 'relay' && wsService?.isConnected()) {
      try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onBack();
  }, [effectiveMode, wsService, sessionId, onBack]);

  const sendMessage = p2pConnection?.sendMessage;
  const onMessage = p2pConnection?.onMessage;
  const waitForConnection = p2pConnection?.waitForConnection;
  const fileOps = useMemo(
    () =>
      sendMessage && onMessage && waitForConnection
        ? createFileOps({ sendMessage, onMessage, waitForConnection })
        : null,
    [sendMessage, onMessage, waitForConnection],
  );

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

  const terminalElement = (
    <Terminal
      ref={terminalRef}
      serverConnection={!isP2P ? wsService : undefined}
      onDisconnect={onDisconnect}
      onError={onError}
      onBannerChange={setToolbarDisabled}
      onCtrlD={onBack}
      renderer={renderer}
    />
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
          sendText={(text) => terminalHandle?.sendText(text)}
          toolbarDisabled={toolbarDisabled}
          fileOps={fileOps}
          onTerminalReveal={() => terminalHandle?.refit()}
          fontSizeManager={terminalHandle?.fontSizeManager ?? null}
          onGetTerminalPwd={fileOps ? handleGetTerminalPwd : undefined}
        />
      </div>
    </div>
  );
}
