import { useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { AttachInfo } from '../types';
import type { WebSocketService } from '../services/websocket';
import { Terminal, type TerminalHandle } from './Terminal';
import { TerminalToolbar } from './TerminalToolbar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useP2PConnection } from '../hooks/useP2PConnection';
import { createFileOps } from '../services/fileOps';
import { FileTabs } from './FileTabs';

export interface AttachedSession {
  attachInfo: AttachInfo;
  sessionId: string;
  sessionName: string;
}

interface TerminalViewProps {
  session: AttachedSession;
  wsService: WebSocketService;
  onBack: () => void;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

export function TerminalView({ session, wsService, onBack, onDisconnect, onError }: TerminalViewProps) {
  const { attachInfo, sessionId, sessionName } = session;
  const isP2P = attachInfo.mode === 'p2p';
  const terminalRef = useRef<TerminalHandle>(null);
  const [toolbarDisabled, setToolbarDisabled] = useState(false);

  const p2pConnection = useP2PConnection(
    isP2P && attachInfo.agent_address
      ? { agentUrl: attachInfo.agent_address, connectionToken: attachInfo.connection_token, sessionName }
      : null,
  );

  const fileOps = p2pConnection ? createFileOps(p2pConnection) : null;

  const terminalElement = (
    <Terminal
      ref={terminalRef}
      sessionId={sessionId}
      sessionName={sessionName}
      mode={attachInfo.mode}
      p2pConnection={isP2P ? p2pConnection : undefined}
      serverConnection={!isP2P ? wsService : undefined}
      onDisconnect={onDisconnect}
      onError={onError}
      onBannerChange={setToolbarDisabled}
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
        <Badge variant={attachInfo.mode === 'p2p' ? 'default' : 'secondary'} className="text-xs">
          {attachInfo.mode.toUpperCase()}
        </Badge>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {fileOps ? (
          <FileTabs
            fileOps={fileOps}
            terminalElement={
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">{terminalElement}</div>
                <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} disabled={toolbarDisabled} />
              </div>
            }
          />
        ) : (
          <>
            <div className="flex-1 min-h-0">{terminalElement}</div>
            <TerminalToolbar sendText={(text) => terminalRef.current?.sendText(text)} />
          </>
        )}
      </div>
    </div>
  );
}
