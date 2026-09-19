import { cn } from '@/shared/lib/utils';
import { SessionFirstTerminalPane } from '@/product/terminal/SessionFirstTerminalPane';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import { useTerminalOrchestration } from '@/product/terminal/useTerminalOrchestration';

export interface SessionFirstTerminalProps {
  hidden: boolean;
  onDisconnect: () => void;
  onError: (error: Error) => void;
  /** What the capsule may show: the chip that earned presence, plus the rest on demand. */
  capsuleCapabilities?: CapsuleCapabilityContribution;
}

/**
 * Session-first terminal entry — native surface + shared xterm engine.
 * Does not use legacy TerminalLayout / dashboard terminal chrome.
 */
export function SessionFirstTerminal({
  hidden,
  onDisconnect,
  onError,
  capsuleCapabilities,
}: SessionFirstTerminalProps) {
  const {
    sessionId,
    controller,
    isSwitching,
    inputDisabled,
    viewportReady,
    terminalState,
    transportEpoch,
  } = useTerminalOrchestration({ onDisconnect, onError });

  return (
    <div
      data-testid="session-first-terminal"
      className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')}
    >
      {!sessionId ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a session to open its terminal.
        </div>
      ) : (
        <TerminalSurface
          inputDisabled={inputDisabled}
          controller={controller}
          isSwitching={isSwitching}
          capsuleCapabilities={capsuleCapabilities}
        >
          <SessionFirstTerminalPane
            sessionId={sessionId}
            controller={controller}
            terminalState={terminalState}
            viewportReady={viewportReady}
            transportEpoch={transportEpoch}
          />
        </TerminalSurface>
      )}
    </div>
  );
}
