// web/src/product/session/state/route.ts
//
// Which route this attachment is using, derived from the attach choice and the
// probe results. These read Session identity (`agentIdAtom`), so they cannot
// live in `platform` — a platform module may not reach up into `product`. That
// constraint, not taste, is what keeps them here (#801 Phase 5).
import { atom } from 'jotai';
import { probeResultsAtom } from '@/product/agent/state/probe';
import {
  p2pStateAtom,
  routeIntentEpochAtom,
  terminalSessionStateAtom,
} from '@/platform/attach/state/transport';
import { resolveAutoP2pUrl } from '@/platform/attach/resolveAutoP2pUrl';
import {
  agentIdAtom,
  attachInfoAtom,
  forcedRelayAtom,
  manualOverrideAtom,
  orderedUrlsAtom,
} from './session';

/** Currently active P2P URL.
 *  1. manualOverride (user explicitly picked a route)
 *  2. orderedUrls from attach choice (dialog / deep-link restore)
 *  3. fastest reachable from probe results
 *  4. legacy agent_address or first candidate from attachInfo
 */
export const activeUrlAtom = atom<string | null>((get) => {
  if (get(forcedRelayAtom)) { return null; }
  const manual = get(manualOverrideAtom);
  if (manual) { return manual; }
  const probe = get(probeResultsAtom).get(get(agentIdAtom) ?? '');
  return resolveAutoP2pUrl(
    get(orderedUrlsAtom),
    probe?.orderedUrls ?? [],
    get(attachInfoAtom),
  );
});

export const effectiveModeAtom = atom<'p2p' | 'relay'>((get) => {
  if (get(forcedRelayAtom)) { return 'relay'; }
  return get(attachInfoAtom)?.mode === 'p2p' ? 'p2p' : 'relay';
});

export const isSwitchingAtom = atom((get) => {
  if (get(terminalSessionStateAtom) === 'failed') {
    return false;
  }
  return get(manualOverrideAtom) !== null && get(p2pStateAtom) !== 'connected';
});

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
        const terminalState = get(terminalSessionStateAtom);
        if (terminalState !== 'failed') {
          set(manualOverrideAtom, null);
          return;
        }
        set(manualOverrideAtom, null);
        set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
        return;
      }
    }

    set(manualOverrideAtom, url);
    set(forcedRelayAtom, false);
    // Bump the route epoch so SessionRuntime detects the route change and the
    // terminal rebuilds its view against the new socket — even when the
    // resolved activeUrl does not change (e.g. Auto → an explicit route that
    // Auto already resolved to).
    set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
  },
);
