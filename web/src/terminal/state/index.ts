// web/src/terminal/state/index.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { terminalSessionAtom, type TerminalSession } from './session';
import { terminalSizeAtomFamily, type TerminalSize, terminalFocusAtomFamily } from './terminal';
import { inputModeAtomFamily, type InputMode } from './input';
import { capabilitiesAtomFamily, type TerminalCapabilities } from './capability';
import { bannerAtomFamily, type ReconnectBanner } from './ui';

export * from './session';
export * from './terminal';
export * from './input';
export * from './ui';
export * from './layout';
export * from './capability';

/** Aggregated view of terminal state for React components to consume. */
export interface TerminalViewModel {
  session: TerminalSession | null;
  size: TerminalSize;
  mode: InputMode;
  focused: boolean;
  capabilities: TerminalCapabilities;
  banner: ReconnectBanner;
}

/** One atom to rule them all — components read a single derived view. */
export const terminalViewModelAtomFamily = atomFamily((sessionId: string) =>
  atom((get): TerminalViewModel => ({
    session: get(terminalSessionAtom),
    size: get(terminalSizeAtomFamily(sessionId)),
    mode: get(inputModeAtomFamily(sessionId)),
    focused: get(terminalFocusAtomFamily(sessionId)),
    capabilities: get(capabilitiesAtomFamily(sessionId)),
    banner: get(bannerAtomFamily(sessionId)),
  })),
);
