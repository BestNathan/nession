// web/src/terminal/state/input.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

// InputMode lives in platform/terminal-runtime so runtime consumers never
// depend on the Jotai state layer; re-exported here for React-side imports.
import type { InputMode } from '@/platform/terminal-runtime/types';
export type { InputMode } from '@/platform/terminal-runtime/types';

export const inputModeAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<InputMode>({ type: 'terminal' });
});

export const inputValueAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<string>('');
});
