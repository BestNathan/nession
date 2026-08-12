// web/src/terminal/state/capability.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/** Feature flags negotiated with the agent (static for now). */
export interface TerminalCapabilities {
  clipboard: boolean;
  search: boolean;
  customInput: boolean;
  aiInput: boolean;
  commandPalette: boolean;
  mouse: boolean;
  resize: boolean;
}

export const capabilitiesAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<TerminalCapabilities>({
    clipboard: true,
    search: false,
    customInput: false,
    aiInput: false,
    commandPalette: false,
    mouse: true,
    resize: true,
  });
});
