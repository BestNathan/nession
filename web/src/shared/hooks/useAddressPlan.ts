import { useMemo } from 'react';
import type { AttachInfo } from '@/types';

interface AddressPlanInput {
  /**
   * Browser-tested URLs resolved upstream (in the attach dialog, or a saved
   * profile's cached order). When provided, they are used as-is with NO
   * re-testing — the browser already measured them.
   */
  orderedUrls: string[] | null;
  /** Manual single-address override (skips ordering, single-entry plan). */
  manualUrl: string | null;
}

/**
 * The ordered list of P2P URLs to attempt for a session attach, best-first.
 *
 * Every path resolves **synchronously** (#1430): the manual override, the
 * pre-resolved order, the advertisement's own priority order, and the legacy
 * single address. There is deliberately no "not ready" state and nothing here
 * consults a browser probe — waiting for `testAddresses` to settle *every*
 * candidate (3s per candidate, in parallel) made the slowest, often
 * unreachable, VPN/LAN sibling part of the create → attach critical path.
 *
 * The measurement still happens — `useAgentProbe` owns it from the attach
 * reply's credential and caches the result — so the next attach starts from a
 * measured order. Nothing waits for it.
 *
 * Deterministic by construction: computed in a `useMemo` rather than resolved
 * in an effect, so there is never a stale render carrying the previous
 * session's address. Rotation through the plan on failure is the caller's
 * concern (`AddressAttachPolicy`).
 */
export function useAddressPlan(
  attachInfo: AttachInfo | null,
  { orderedUrls, manualUrl }: AddressPlanInput,
): string[] {
  return useMemo(() => {
    if (!attachInfo || attachInfo.mode !== 'p2p') {
      return [];
    }

    // 1. Manual selection: use exactly that address, no rotation.
    if (manualUrl) {
      return [manualUrl];
    }

    // 2. The measured order, when one is already in hand. An EMPTY array is
    //    not an order — it means this attach has no measurement yet.
    if (orderedUrls && orderedUrls.length > 0) {
      return orderedUrls;
    }

    // 3. The advertisement's own order. The agent priority-sorts its address
    //    list (`crates/nession-common/src/address.rs`: de-duplicate, stable
    //    sort by priority), so the first entry is the right first attempt and
    //    rotation walks the rest.
    const candidates = attachInfo.addresses ?? [];
    if (candidates.length > 0) {
      return candidates.map((candidate) => candidate.url);
    }

    // 4. No candidates at all — the legacy single address.
    return attachInfo.agent_address ? [attachInfo.agent_address] : [];
  }, [attachInfo, orderedUrls, manualUrl]);
}
