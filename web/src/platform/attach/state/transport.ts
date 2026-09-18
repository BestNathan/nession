// web/src/platform/attach/state/transport.ts
//
// Transport state for an attachment. These three are the only atoms in the old
// `atoms/` cluster that read nothing from a layer above `platform` — no session
// identity, no terminal status, no probe — which is what puts them here rather
// than with the session state they are used alongside. (#801 Phase 5: state
// follows ownership, not "it is a Jotai atom".)
import { atom } from 'jotai';
import type { ConnectionState } from '@/platform/socket/types';

export const p2pStateAtom = atom<ConnectionState>('disconnected');

/** User-initiated route switch epoch — resets P2P candidate index when changed. */
export const routeIntentEpochAtom = atom(0);

/** Runtime-owned transport generation — candidate rotation / endpoint switch. */
export const transportGenerationAtom = atom(0);
