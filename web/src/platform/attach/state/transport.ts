// web/src/platform/attach/state/transport.ts
//
// Transport state for an attachment. These three are the only atoms in the old
// `atoms/` cluster that read nothing from a layer above `platform` — no session
// identity, no terminal status, no probe — which is what puts them here rather
// than with the session state they are used alongside. (#801 Phase 5: state
// follows ownership, not "it is a Jotai atom".)
import { atom } from 'jotai';
import type { ConnectionState } from '@/platform/socket/types';
import type { TerminalStatus } from '@/types';

/**
 * Attach lifecycle status of the local terminal connection.
 *
 * It lives here, below both of its users, and that placement is load-bearing:
 * `product/session/state` **writes** it (the attach and disconnect actions) and
 * `product/terminal/state` **reads** it. Defining it in the terminal state —
 * where it was imported from — makes those two modules import each other, and
 * the app was broken by exactly that cycle when this refactor first tried it.
 *
 * The original code kept the atom in `atoms/` for the same reason, and said so:
 * "these session atoms write it … a shared atom could not have lived in
 * `features/`". Only the layer name changed; the constraint never did.
 */
export const terminalSessionStateAtom = atom<TerminalStatus>('idle');

export const p2pStateAtom = atom<ConnectionState>('disconnected');

/** User-initiated route switch epoch — resets P2P candidate index when changed. */
export const routeIntentEpochAtom = atom(0);

/** Runtime-owned transport generation — candidate rotation / endpoint switch. */
export const transportGenerationAtom = atom(0);
