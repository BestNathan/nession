// web/src/platform/attach/state/transport.ts
//
// Attach-transport state that reads nothing from a layer above `platform` —
// no session identity, no terminal status, no probe — which is what puts it
// here rather than with the session state it is used alongside. (#801 Phase
// 5: state follows ownership, not "it is a Jotai atom".)
//
// The attach lifecycle itself is NOT here: `terminalSessionStateAtom` was
// deleted in #1309, when the SessionRuntime became the single authority for
// the attach phase (read `runtime.getSnapshot().phase`, or the registry for
// an imperative read-back).
import { atom } from 'jotai';

/** User-initiated route switch epoch — resets P2P candidate index when changed. */
export const routeIntentEpochAtom = atom(0);
