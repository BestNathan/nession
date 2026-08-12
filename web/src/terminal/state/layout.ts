// web/src/terminal/state/layout.ts
import { atom } from 'jotai';

export const sidebarOpenAtom = atom<boolean>(false);

/** Sidebar/panel split sizes in arbitrary units (percent). */
export const panelSizesAtom = atom<number[]>([70, 30]);
