// web/src/product/session/state/route.ts
//
// Route mode and manual P2P switching for the active attachment. These read
// Session identity (`agentIdAtom`), so they cannot
// live in `platform` — a platform module may not reach up into `product`. That
// constraint, not taste, is what keeps them here (#801 Phase 5).
import { atom } from 'jotai';
import { probeResultsAtom } from '@/product/agent/state/probe';
import { routeIntentEpochAtom } from '@/platform/attach/state/transport';
import { sessionRuntimeRegistry } from '@/platform/session-runtime/SessionRuntimeRegistry';
import { resolveAutoP2pUrl } from '@/platform/attach/resolveAutoP2pUrl';
import {
  agentIdAtom,
  attachInfoAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
  sessionIdAtom,
} from './session';

export const switchAddressAtom = atom(
  null,
  (get, set, url: string | null) => {
    // No-op when the user re-selects the route they're already on — same
    // manualOverride source.  Without this guard the unconditional
    // disconnect/reconnect cycle below would flash a spinner (isSwitching
    // becomes true while p2pState catches up) for what is logically a no-op,
    // and needlessly tear down a live P2P socket.
    //
    // Two no-op cases:
    //   1. Explicit URL re-selected (url === currentOverride !== null)
    //   2. Auto re-selected (url === null && currentOverride === null)
    //
    // The Auto → explicit-same-URL case is intentionally NOT short-circuited:
    // there manualOverride changes (null → url) so the source of the URL
    // changed and the epoch bump / rebuild still has to fire.
    // Re-probe latency changes also don't come through here (they update
    // probeResultsAtom directly), so a same-source Auto selection truly
    // means "no state change needed".
    const currentOverride = get(manualOverrideAtom);
    if (url === currentOverride) {
      return;
    }

    // Explicit → Auto when Auto would resolve to the same URL: clear override only.
    // Skips disconnect/reconnect and useAddressPlan async re-probe (orderedUrls already set).
    if (url === null && currentOverride !== null) {
      const probe = get(probeResultsAtom).get(get(agentIdAtom) ?? '');
      const autoUrl = resolveAutoP2pUrl(
        get(orderedUrlsAtom),
        probe?.orderedUrls ?? [],
        get(attachInfoAtom),
      );
      if (autoUrl === currentOverride) {
        // The failed-phase read-back asks the runtime — the only owner of the
        // attach phase (#1309 SC-01). No runtime (nothing attached, or the
        // terminal subtree unmounted) reads as not-failed: there is no live
        // attach to recover, so clearing the override is enough.
        const terminalPhase =
          sessionRuntimeRegistry.get(get(sessionIdAtom))?.getSnapshot().phase ?? 'idle';
        if (terminalPhase !== 'failed') {
          set(manualOverrideAtom, null);
          return;
        }
        set(manualOverrideAtom, null);
        set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
        return;
      }
    }

    set(manualOverrideAtom, url);
    // Bump the route epoch so SessionRuntime detects the route change and the
    // terminal rebuilds its view against the new socket — even when the
    // resolved activeUrl does not change (e.g. Auto → an explicit route that
    // Auto already resolved to).
    set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
  },
);
