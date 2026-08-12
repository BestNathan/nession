// web/src/terminal/state/input.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/** Discriminated union of terminal input modes. */
export type InputMode =
  | { type: 'terminal' }
  | { type: 'command' }
  | { type: 'search' }
  | { type: 'ai' }
  | { type: 'custom'; id: string };

export const inputModeAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<InputMode>({ type: 'terminal' });
});

export const inputValueAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<string>('');
});
