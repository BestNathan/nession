// web/src/terminal/state/terminal.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/** Terminal viewport size in cells. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

export const terminalSizeAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<TerminalSize>({ cols: 80, rows: 24 });
});

export const terminalFocusAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<boolean>(false);
});

export const terminalSelectionAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<string>('');
});

export const terminalTitleAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<string>('');
});
