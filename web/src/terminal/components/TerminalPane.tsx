import { useAtomValue } from 'jotai';
import type { TerminalController } from '../controller/TerminalController';
import { terminalViewModelAtomFamily } from '../state';
import { TerminalBanner } from './TerminalBanner';
import { TerminalViewport } from './TerminalViewport';
import { TerminalInputOverlay } from './input/TerminalInputOverlay';

interface TerminalPaneProps {
  sessionId: string;
  controller: TerminalController | null;
  reconnectAttempt: number;
}

/**
 * Single-session terminal container.
 *
 * Composes the banner overlay, the xterm mount point, and the input-mode
 * overlay. Banner state comes from the terminal view model atom; the
 * controller and reconnect counter are supplied by the parent so the pane
 * stays a pure composition of presentational pieces.
 */
export function TerminalPane({ sessionId, controller, reconnectAttempt }: TerminalPaneProps) {
  const viewModel = useAtomValue(terminalViewModelAtomFamily(sessionId));

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <TerminalBanner banner={viewModel.banner} reconnectAttempt={reconnectAttempt} />
      <div className="relative min-h-0 flex-1">
        <TerminalViewport controller={controller} />
      </div>
      <TerminalInputOverlay sessionId={sessionId} />
    </div>
  );
}
