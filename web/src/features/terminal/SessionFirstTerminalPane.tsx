import { Loader2 } from 'lucide-react';
import type { TerminalController } from '@/core/terminal-runtime/controller/TerminalController';
import { TerminalViewport } from '@/features/terminal/components/TerminalViewport';
import { TerminalInputOverlay } from '@/features/terminal/components/input/TerminalInputOverlay';
import { isTerminalLive } from '@/features/terminal/useSessionFirstTerminalAttach';
import type { TerminalStatus } from '@/features/terminal/state/session';

interface SessionFirstTerminalPaneProps {
  sessionId: string;
  controller: TerminalController | null;
  terminalState: TerminalStatus;
  viewportReady: boolean;
  /**
   * Bumped when the runtime swaps its live agent-terminal API (post-swap by
   * construction) — rewires the ConnectionManager to the new socket (#668).
   */
  transportEpoch: number;
}

/**
 * Session-first native terminal viewport — xterm only, no legacy relay banner.
 * Connection lifecycle is shown in SessionHeader / ConnectionStatus.
 */
export function SessionFirstTerminalPane({
  sessionId,
  controller,
  terminalState,
  viewportReady,
  transportEpoch,
}: SessionFirstTerminalPaneProps) {
  const showViewport = Boolean(controller) && viewportReady;
  const showBlockingLoader = !controller || !viewportReady;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="session-first-terminal-pane">
      <div className="relative min-h-0 flex-1">
        {showViewport ? (
          <TerminalViewport controller={controller} transportEpoch={transportEpoch} />
        ) : null}
        {showBlockingLoader ? (
          <div
            data-testid="session-first-terminal-loading"
            className="absolute inset-0 flex items-center justify-center bg-terminal-background"
          >
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {showViewport && !isTerminalLive(terminalState) ? (
          <div
            data-testid="session-first-terminal-connecting"
            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-terminal-background/60"
          >
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
      {showViewport ? <TerminalInputOverlay sessionId={sessionId} /> : null}
    </div>
  );
}
