import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { sessionNameAtom } from '@/product/session/state/session';

export type TerminalControlRole = 'controller' | 'observer';

export interface TerminalControlState {
  role: TerminalControlRole;
  generation?: number;
  controllerClientId?: string;
  /** Family key — not sent on the wire. */
  sessionName?: string;
}

const defaultControl: TerminalControlState = { role: 'controller' };

/** Per-session control lease snapshot (#1095). Keyed by short session name. */
export const terminalControlAtomFamily = atomFamily((sessionName: string) =>
  atom<TerminalControlState>({ ...defaultControl, sessionName }),
);

/** Control state for the active session in the shell. */
export const activeTerminalControlAtom = atom((get) => {
  const name = get(sessionNameAtom);
  if (!name) {
    return defaultControl;
  }
  return get(terminalControlAtomFamily(name));
});
