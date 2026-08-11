import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { AttachInfo, AddressLatency, Session, EnvFileRef } from '../types';
import { Terminal, type TerminalHandle } from './Terminal';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useP2PWithFallback } from '../hooks/useP2PWithFallback';
import { createFileOps } from '../services/fileOps';
import { AddressSelector } from './AddressSelector';
import { useWebSocket } from '../hooks/useWebSocket';
import { useTerminalSessions } from '../hooks/useTerminalSessions';
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { SessionDropdown } from './SessionDropdown';
import { TerminalLayout } from './TerminalLayout';

interface TerminalHeaderProps {
  onBack: () => void;
  sessionName: string;
  effectiveMode: 'p2p' | 'relay';
  attachInfo: AttachInfo;
  forcedRelay: boolean;
  latencies?: AddressLatency[];
  // NEW — session list data for the dropdown
  sessions: Session[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  onRetrySessions: () => void;
  probeCache: ReturnType<typeof useAddressProbeCache>;
}

function TerminalHeader({
  onBack, sessionName, effectiveMode,
  attachInfo, forcedRelay, latencies,
  sessions, sessionsLoading, sessionsError, onRetrySessions,
  probeCache,
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
        probeCache={probeCache}
      />
      <Badge variant={effectiveMode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
        {effectiveMode.toUpperCase()}
        {forcedRelay && attachInfo.mode === 'p2p' ? ' (fallback)' : ''}
      </Badge>
      {attachInfo.mode === 'p2p' && attachInfo.addresses ? (
        <AddressSelector
          addresses={attachInfo.addresses}
          latencies={latencies ?? []}
          effectiveMode={effectiveMode}
        />
      ) : null}
    </header>
  );
}

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

interface TerminalViewProps {
  session: AttachedSession;
  onBack: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

export function TerminalView({ session, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName, selectedAddress, orderedUrls, latencies, renderer, relayUrl } = session;
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
  const probeCache = useAddressProbeCache([]);

  // Multi-address P2P: connect the browser-tested best path (resolved in the
  // attach dialog), rotate on failure, fall back to relay.
  const {
    p2pConnection,
    effectiveMode,
    forcedRelay,
    isSwitching,
  } = useP2PWithFallback(attachInfo, sessionName, {
    orderedUrls: orderedUrls ?? null,
    initialSelectedAddress: selectedAddress ?? null,
  });
  const isP2P = effectiveMode === 'p2p';
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
    const refs = session.envRefs;
    if (!refs || refs.length === 0 || envSourcedRef.current === sessionId) {
      return;
    }
    const apply = () => {
      if (envSourcedRef.current === sessionId) {
        return;
      }
      envSourcedRef.current = sessionId;
      for (const ref of refs) {
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
  }, [session.envRefs, sessionId, effectiveMode, p2pConnection, wsService]);

  const handleGetTerminalPwd = useCallback(async () => {
    if (!fileOps) {throw new Error('File ops not available');}
    return (await fileOps.getCwd(sessionId)).path;
  }, [fileOps, sessionId]);

  const terminalElement = (
    <Terminal
      ref={terminalRef}
      sessionId={sessionId}
      sessionName={sessionName}
      mode={effectiveMode}
      p2pConnection={isP2P ? p2pConnection : undefined}
      serverConnection={!isP2P ? wsService : undefined}
      relayUrl={relayUrl}
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
        probeCache={probeCache}
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
