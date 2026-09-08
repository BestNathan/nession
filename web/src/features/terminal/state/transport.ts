import { atom } from 'jotai';

/** True once TerminalController.attach() has wired ConnectionManager handlers. */
export const terminalTransportReadyAtom = atom(false);
