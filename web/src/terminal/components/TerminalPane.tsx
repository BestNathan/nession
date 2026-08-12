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
    <div className="flex-1 min-w-0 min-h-0 relative">
      <TerminalBanner banner={viewModel.banner} reconnectAttempt={reconnectAttempt} />
      <TerminalViewport controller={controller} />
      <TerminalInputOverlay sessionId={sessionId} />
    </div>
  );
}
