import { cn } from '@/lib/utils';
import { SessionFirstTerminalPane } from '@/features/terminal/SessionFirstTerminalPane';
import { TerminalSurface } from '@/features/terminal/TerminalSurface';
import type { CapsuleCapabilityPresence } from '@/features/terminal/capsule/types';
import { useTerminalOrchestration } from '@/features/terminal/useTerminalOrchestration';

export interface SessionFirstTerminalProps {
  hidden: boolean;
  onDisconnect: () => void;
  onError: (error: Error) => void;
  /** The capability that earned capsule presence, if any. At most one. */
  capsuleCapability?: CapsuleCapabilityPresence;
}

/**
 * Session-first terminal entry — native surface + shared xterm engine.
 * Does not use legacy TerminalLayout / dashboard terminal chrome.
 */
export function SessionFirstTerminal({
  hidden,
  onDisconnect,
  onError,
  capsuleCapability,
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
          Select a session
        </div>
      ) : (
        <TerminalSurface
          inputDisabled={inputDisabled}
          controller={controller}
          isSwitching={isSwitching}
          capsuleCapability={capsuleCapability}
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
