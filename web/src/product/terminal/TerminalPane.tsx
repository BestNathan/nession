import { Loader2 } from 'lucide-react';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { TerminalViewport } from '@/product/terminal/components/TerminalViewport';
import { TerminalInputOverlay } from '@/product/terminal/components/input/TerminalInputOverlay';
import { isTerminalLive } from '@/product/terminal/useTerminalAttach';
import type { TerminalStatus } from '@/product/terminal/state/session';

interface TerminalPaneProps {
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
export function TerminalPane({
  sessionId,
  controller,
  terminalState,
  viewportReady,
  transportEpoch,
}: TerminalPaneProps) {
  const showViewport = Boolean(controller) && viewportReady;
  const showBlockingLoader = !controller || !viewportReady;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="terminal-pane">
      <div className="relative min-h-0 flex-1">
        {showViewport ? (
          <TerminalViewport controller={controller} transportEpoch={transportEpoch} />
        ) : null}
        {showBlockingLoader ? (
          <div
            data-testid="terminal-loading"
            className="absolute inset-0 flex items-center justify-center bg-terminal-background"
          >
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {showViewport && !isTerminalLive(terminalState) ? (
          <div
            data-testid="terminal-connecting"
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
