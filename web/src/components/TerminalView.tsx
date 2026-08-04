import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, Menu } from 'lucide-react';
import type { AttachInfo, AddressLatency, Session } from '../types';
import { Terminal, type TerminalHandle } from './Terminal';
import type { BottomTab } from './BottomBar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useP2PWithFallback } from '../hooks/useP2PWithFallback';
import { createFileOps } from '../services/fileOps';
import { AddressSelector } from './AddressSelector';
import { useWebSocket } from '../hooks/useWebSocket';
import { useTerminalSessions } from '../hooks/useTerminalSessions';
import { useAddressProbeCache } from '../hooks/useAddressProbeCache';
import { SessionPanel } from './SessionPanel';
import type { AttachChoice } from './env/AttachDialog';
import { TerminalLayout } from './TerminalLayout';

interface TerminalHeaderProps {
  panelOpen: boolean;
  onTogglePanel: () => void;
  onBack: () => void;
  sessionName: string;
  effectiveMode: 'p2p' | 'relay';
  attachInfo: AttachInfo;
  forcedRelay: boolean;
  latencies?: AddressLatency[];
  activeUrl: string | null;
  manualOverride: string | null;
  setManualOverride: (url: string | null) => void;
}

function TerminalHeader({
  panelOpen, onTogglePanel, onBack, sessionName, effectiveMode,
  attachInfo, forcedRelay, latencies, activeUrl, manualOverride, setManualOverride,
}: TerminalHeaderProps) {
  return (
    <header className="border-b px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-4 flex-shrink-0 flex-wrap">
      <Button
        variant={panelOpen ? 'secondary' : 'ghost'}
        size="sm"
        onClick={onTogglePanel}
        title="Toggle session list"
      >
        <Menu className="w-4 h-4 mr-1" /> Sessions
      </Button>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="w-4 h-4 mr-1" /> Back
      </Button>
      <span className="text-sm text-muted-foreground">
        Session: <strong className="text-foreground">{sessionName}</strong>
      </span>
      <Badge variant={effectiveMode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
        {effectiveMode.toUpperCase()}
        {forcedRelay && attachInfo.mode === 'p2p' ? ' (fallback)' : ''}
      </Badge>
      {attachInfo.mode === 'p2p' && !forcedRelay && attachInfo.addresses ? (
        <AddressSelector
          addresses={attachInfo.addresses}
          latencies={latencies ?? []}
          activeUrl={activeUrl ?? null}
          isAuto={manualOverride === null}
          onSelect={setManualOverride}
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
}

interface TerminalViewProps {
  session: AttachedSession;
  onBack: () => void;
  onSwitchSession: (session: Session, choice: AttachChoice) => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

export function TerminalView({ session, onBack, onSwitchSession, onDisconnect, onError }: TerminalViewProps) {
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [toolbarDisabled, setToolbarDisabled] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('commands');
  const [sheetOpen, setSheetOpen] = useState(false);

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
    activeUrl,
    forcedRelay,
    manualOverride,
    setManualOverride,
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

  const handleSwitchSession = useCallback((s: Session, choice: AttachChoice) => {
    if (effectiveMode === 'relay' && wsService?.isConnected()) {
      try { wsService.endRelay(sessionId); } catch { /* best-effort */ }
    }
    onSwitchSession(s, choice);
  }, [effectiveMode, wsService, sessionId, onSwitchSession]);

  // Stable across re-renders. The hook returns a fresh object literal each
  // render, but its transport methods are useCallback-stable for the
  // connection's lifetime and fileOps uses only those — not the mutating
  // connectionState field. Keying the memo on those stable refs recreates
  // fileOps only when the connection is rebuilt, so FileBrowser's
  // load-on-mount effect doesn't re-fire on every state transition.
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
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((p) => !p)}
        onBack={handleBack}
        sessionName={sessionName}
        effectiveMode={effectiveMode}
        attachInfo={attachInfo}
        forcedRelay={forcedRelay}
        latencies={latencies}
        activeUrl={activeUrl ?? null}
        manualOverride={manualOverride}
        setManualOverride={setManualOverride}
      />

      <div className="flex-1 min-h-0 flex">
        {panelOpen && (
          <SessionPanel
            sessions={sessions}
            loading={sessionsLoading}
            error={sessionsError}
            onRetry={refetchSessions}
            currentSessionId={sessionId}
            onSwitchSession={handleSwitchSession}
            probeCache={probeCache}
            defaultOpen
          />
        )}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <TerminalLayout
            terminalElement={terminalElement}
            bottomTab={bottomTab}
            onBottomTabChange={setBottomTab}
            sheetOpen={sheetOpen}
            onSheetToggle={setSheetOpen}
            sessionId={sessionId}
            sessionName={sessionName}
            sendText={(text) => terminalHandle?.sendText(text)}
            toolbarDisabled={toolbarDisabled}
            fileOps={fileOps}
            onTerminalReveal={() => terminalHandle?.refit()}
            fontSizeManager={terminalHandle?.fontSizeManager ?? null}
            focusTerminal={() => terminalHandle?.focusTerminal()}
          />
        </div>
      </div>
    </div>
  );
}
