import { useAtomValue } from 'jotai';
import { inputModeAtomFamily } from '../../state/input';

interface TerminalInputOverlayProps {
  sessionId: string;
}

/**
 * Overlay layer for non-terminal input modes.
 *
 * Reads the session's input mode and renders the corresponding input UI on
 * top of the terminal. All cases currently return null — CommandPalette,
 * SearchInput, AIInput, and CustomInput are implemented in later tasks.
 */
export function TerminalInputOverlay({ sessionId }: TerminalInputOverlayProps) {
  const mode = useAtomValue(inputModeAtomFamily(sessionId));

  switch (mode.type) {
    case 'terminal':
      return null;
    case 'command':
      return null;
    case 'search':
      return null;
    case 'ai':
      return null;
    case 'custom':
      return null;
  }
}
