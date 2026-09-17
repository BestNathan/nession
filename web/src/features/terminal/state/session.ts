// web/src/terminal/state/session.ts
import { atom } from 'jotai';
import { sessionIdAtom, sessionNameAtom, terminalSessionStateAtom } from '@/atoms/session';
import { effectiveModeAtom } from '@/atoms/connection';

// TerminalStatus/TerminalSession live in core/terminal-runtime so runtime
// consumers never depend on the Jotai state layer; re-exported here for
// React-side imports.
import type { TerminalSession } from '@/core/terminal-runtime/types';
export type { TerminalSession, TerminalStatus } from '@/core/terminal-runtime/types';
// Current terminal connection status. Defined in `atoms/session.ts` and
// re-exported here: the session atoms write it, and `atoms/` is `shared`, which
// cannot import a feature. This keeps the feature-side import path stable (#783).
export { terminalSessionStateAtom };

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
