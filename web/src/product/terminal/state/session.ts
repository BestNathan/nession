// web/src/product/terminal/state/session.ts
import { atom } from 'jotai';
import { sessionIdAtom, sessionNameAtom } from '@/product/session/state/session';
import { effectiveModeAtom } from '@/product/session/state/route';

// TerminalStatus/TerminalSession live in platform/terminal-runtime so runtime
// consumers never depend on the Jotai state layer; re-exported here for
// React-side imports.
import type { TerminalSession, TerminalStatus } from '@/platform/terminal-runtime/types';
export type { TerminalSession, TerminalStatus } from '@/platform/terminal-runtime/types';

/**
 * Current terminal connection status — driven by the attach/disconnect/switch
 * actions in `product/session/state` and the state machine effect in the
 * terminal hooks.
 *
 * It used to be *defined* in `atoms/session.ts` and re-exported from here, with
 * a comment explaining that `atoms/` was `shared` and could not import a
 * feature, so the writer had to live below the terminal (#783). That reason is
 * gone: the writers are `product/session/state` now, which may reach
 * `product/terminal` directly, so the atom is simply owned here.
 */
export const terminalSessionStateAtom = atom<TerminalStatus>('idle');

/** Private: pinned by terminalSessionAtom's write so startedAt stays stable. */
const startedAtAtom = atom<number>(0);

/**
 * Terminal session derived from the global atoms. Writable with no arguments
 * to stamp `startedAt` with the current time (e.g. when attach is initiated).
 */
export const terminalSessionAtom = atom<TerminalSession | null, [], void>(
  (get) => {
    const id = get(sessionIdAtom);
    if (!id) { return null; }
    return {
      id,
      name: get(sessionNameAtom),
      status: get(terminalSessionStateAtom),
      mode: get(effectiveModeAtom),
      startedAt: get(startedAtAtom),
    };
  },
  (_get, set) => {
    set(startedAtAtom, Date.now());
  },
);
