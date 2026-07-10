import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, TerminalIcon, Package } from 'lucide-react';
import type { AttachInfo } from '../types';
import type { WebSocketService } from '../services/websocket';
import { Terminal, type TerminalHandle } from './Terminal';
import { TerminalToolbar } from './TerminalToolbar';
import { EnvPanel } from './env/EnvPanel';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import { useP2PWithFallback } from '../hooks/useP2PWithFallback';
import { createFileOps } from '../services/fileOps';
import { FileTabs } from './FileTabs';
import { AddressSelector } from './AddressSelector';

export interface AttachedSession {
  attachInfo: AttachInfo;
  sessionId: string;
  sessionName: string;
  /**
   * Browser-tested candidate URLs, best-first, resolved in the attach dialog.
   * The connection layer uses these directly (no re-testing) and rotates
   * through them on failure. Empty → straight to relay.
   */
  orderedUrls?: string[];
  /**
   * User-selected P2P address (manual override). When set, auto latency
   * selection is skipped and this exact URL is used (no address rotation).
   */
  selectedAddress?: string;
}

interface TerminalViewProps {
  session: AttachedSession;
  wsService: WebSocketService;
  onBack: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

export function TerminalView({ session, wsService, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName, selectedAddress, orderedUrls } = session;
  const terminalRef = useRef<TerminalHandle>(null);
  const [toolbarDisabled, setToolbarDisabled] = useState(false);
  const [bottomTab, setBottomTab] = useState<'commands' | 'env'>('commands');

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
      onDisconnect={onDisconnect}
      onError={onError}
      onBannerChange={setToolbarDisabled}
      onCtrlD={onBack}
    />
  );

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
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
            activeUrl={activeUrl ?? null}
            isAuto={manualOverride === null}
            onSelect={setManualOverride}
          />
        ) : null}
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {fileOps ? (
          <FileTabs
            fileOps={fileOps}
            onTerminalReveal={() => terminalRef.current?.refit()}
            terminalElement={
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">{terminalElement}</div>
                <BottomBar
                  activeTab={bottomTab}
                  onTabChange={setBottomTab}
                  envPanel={<EnvPanel wsService={wsService} sessionId={sessionId} />}
                  commandsPanel={
                    <TerminalToolbar
                      sendText={(text) => terminalRef.current?.sendText(text)}
                      disabled={toolbarDisabled}
                    />
                  }
                />
              </div>
            }
          />
        ) : (
          <>
            <div className="flex-1 min-h-0">{terminalElement}</div>
            <BottomBar
              activeTab={bottomTab}
              onTabChange={setBottomTab}
              envPanel={<EnvPanel wsService={wsService} sessionId={sessionId} />}
              commandsPanel={
                <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Bottom bar: tabbed Env Files / Quick Commands ────────────────────────

function BottomBar({
  activeTab,
  onTabChange,
  envPanel,
  commandsPanel,
}: {
  activeTab: 'commands' | 'env';
  onTabChange: (tab: 'commands' | 'env') => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
}) {
  return (
    <div className="border-t flex-shrink-0 flex flex-col h-[116px]">
      <div className="flex border-b">
        <button
          type="button"
          onClick={() => onTabChange('commands')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            activeTab === 'commands'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <TerminalIcon className="w-3 h-3" /> Commands
        </button>
        <button
          type="button"
          onClick={() => onTabChange('env')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            activeTab === 'env'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Package className="w-3 h-3" /> Env
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'env' ? envPanel : commandsPanel}
      </div>
    </div>
  );
}
