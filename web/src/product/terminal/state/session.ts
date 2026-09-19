// web/src/product/terminal/state/session.ts
import { atom } from 'jotai';
import { sessionIdAtom, sessionNameAtom } from '@/product/session/state/session';
import { effectiveModeAtom } from '@/product/session/state/route';
import { terminalSessionStateAtom } from '@/platform/attach/state/transport';

// TerminalStatus/TerminalSession live in platform/terminal-runtime so runtime
// consumers never depend on the Jotai state layer; re-exported here for
// React-side imports.
import type { TerminalSession } from '@/platform/terminal-runtime/types';
export type { TerminalSession, TerminalStatus } from '@/platform/terminal-runtime/types';

/**
 * Current terminal connection status — driven by the attach/disconnect/switch
 * actions in `product/session/state` and the state machine effect in the
 * terminal hooks.
 *
 * Re-exported, not defined: it lives in `platform/attach/state/transport.ts`,
 * below both this module and the `product/session` actions that write it.
 * Defining it here instead makes `product/session/state` and this file import
 * each other — which is what an earlier revision of this refactor did, and it
 * deterministically broke relay-mode terminal I/O in e2e.
 */
export { terminalSessionStateAtom } from '@/platform/attach/state/transport';

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
