import { cn } from '@/lib/utils';
import {
  SessionFirstTerminalPane,
  TerminalSurface,
  useTerminalOrchestration,
} from '@/session-first/terminal';

export interface SessionFirstTerminalProps {
  hidden: boolean;
  onDisconnect: () => void;
  onError: (error: Error) => void;
}

/**
 * Session-first terminal entry — native surface + shared xterm engine.
 * Does not use legacy TerminalLayout / dashboard terminal chrome.
 */
export function SessionFirstTerminal({ hidden, onDisconnect, onError }: SessionFirstTerminalProps) {
  const {
    sessionId,
    controller,
    isSwitching,
    inputDisabled,
    viewportReady,
    terminalState,
    transportKey,
  } = useTerminalOrchestration({ onDisconnect, onError });

  return (
    <div
      data-testid="session-first-terminal"
      className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')}
    >
      {!sessionId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a session
        </div>
      ) : (
        <TerminalSurface
          inputDisabled={inputDisabled}
          controller={controller}
          isSwitching={isSwitching}
          onScrollPages={(pages) => controller?.scrollPages(pages)}
          onScrollToBottom={() => controller?.scrollToBottom()}
        >
          <SessionFirstTerminalPane
            sessionId={sessionId}
            controller={controller}
            terminalState={terminalState}
            viewportReady={viewportReady}
            transportKey={transportKey}
          />
        </TerminalSurface>
      )}
    </div>
  );
}
