import { useEffect, useRef, useState, useMemo } from 'react';
import type { AttachInfo, ProbedAddress } from '../types';
import { orderAddressesByLatency } from '../services/addressSelection';

/** Shared async probe cache — dedupes browser latency tests across hook instances. */
const inflightProbes = new Map<string, Promise<string[]>>();
const resolvedProbes = new Map<string, string[]>();

function probeAddresses(
  asyncKey: string,
  candidates: ProbedAddress[],
  agentAddress: string | null,
): Promise<string[]> {
  const cached = resolvedProbes.get(asyncKey);
  if (cached) {
    return Promise.resolve(cached);
  }
  let inflight = inflightProbes.get(asyncKey);
  if (!inflight) {
    inflight = orderAddressesByLatency(candidates).then((urls) => {
      const finalUrls =
        urls.length > 0 ? urls : agentAddress ? [agentAddress] : [];
      resolvedProbes.set(asyncKey, finalUrls);
      inflightProbes.delete(asyncKey);
      return finalUrls;
    });
    inflightProbes.set(asyncKey, inflight);
  }
  return inflight;
}

/** Outcome of resolving which P2P endpoint(s) to try for an attach. */
export interface AddressPlan {
  /** Ordered candidate URLs to attempt, best-first. */
  urls: string[];
  /** True once selection has finished (or was pre-resolved / skipped). */
  ready: boolean;
}

interface AddressPlanInput {
  /**
   * Browser-tested URLs resolved upstream (in the attach dialog). When
   * provided, they are used as-is with NO re-testing — the browser already
   * measured them. `null` means "resolve here" (legacy / programmatic paths).
   */
  orderedUrls: string[] | null;
  /** Manual single-address override (skips ordering, single-entry plan). */
  manualUrl: string | null;
}

/**
 * Resolve the ordered list of P2P URLs to attempt for a session attach.
 *
 * Priority:
 * 1. Manual override → single-entry plan.
 * 2. Pre-resolved `orderedUrls` from the dialog's browser test → used verbatim.
 * 3. Fallback (no pre-resolved list): browser-test `attachInfo.addresses` here,
 *    or use the legacy single `agent_address`.
 *
 * Rotation through the plan on failure is the caller's concern.
 *
 * IMPORTANT: Deterministic resolution paths (manual URL, pre-resolved URLs,
 * legacy agent_address, non-P2P mode) are computed SYNCHRONOUSLY via
 * useMemo so there is never a stale render with the previous session's
 * agent address. Only the async browser-test path uses useState+useEffect.
 */
export function useAddressPlan(
  attachInfo: AttachInfo | null,
  { orderedUrls, manualUrl }: AddressPlanInput,
): AddressPlan {
  // ── Deterministic resolution (synchronous — no stale state) ──────────

  const syncPlan = useMemo<AddressPlan>(() => {
    if (!attachInfo || attachInfo.mode !== 'p2p') {
      return { urls: [], ready: true };
    }

    // 1. Manual selection: use exactly that address, no rotation.
    if (manualUrl) {
      return { urls: [manualUrl], ready: true };
    }

    // 2. Pre-resolved order from the attach dialog's browser test. An EMPTY
    //    array is NOT a valid pre-resolved plan — it means the dialog had no
    //    cached probe yet. Fall through to path 3.
    if (orderedUrls && orderedUrls.length > 0) {
      return { urls: orderedUrls, ready: true };
    }

    // 3. No candidates at all — fall back to legacy agent_address.
    const candidates: ProbedAddress[] = attachInfo.addresses ?? [];
    if (candidates.length === 0) {
      return { urls: attachInfo.agent_address ? [attachInfo.agent_address] : [], ready: true };
    }

    // 4. Candidates exist but no pre-resolved order — async browser test needed.
    return { urls: [], ready: false };
  }, [attachInfo, orderedUrls, manualUrl]);

  // ── Async browser-test fallback ─────────────────────────────────────

  const [asyncUrls, setAsyncUrls] = useState<string[]>([]);

  const candidates: ProbedAddress[] = attachInfo?.addresses ?? [];
  const agentAddress = attachInfo?.agent_address ?? null;
  // Stable key for the async effect — only changes when candidates actually differ.
  const asyncKey = `${candidates.map((a) => a.url).join(',')}|${agentAddress ?? ''}`;

  const inputsRef = useRef({ candidates, agentAddress });
  inputsRef.current = { candidates, agentAddress };

  const activeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (syncPlan.ready) {
      // Sync plan resolved — clear any stale async result.
      setAsyncUrls([]);
      return;
    }

    // syncPlan is not ready → browser-test the candidates.
    const inputs = inputsRef.current;
    activeKeyRef.current = asyncKey;

    let cancelled = false;
    void probeAddresses(asyncKey, inputs.candidates, inputs.agentAddress).then((finalUrls) => {
      if (cancelled || activeKeyRef.current !== asyncKey) {
        return;
      }
      setAsyncUrls(finalUrls);
    });

    return () => {
      cancelled = true;
    };
  }, [asyncKey, syncPlan.ready]);

  // ── Return ──────────────────────────────────────────────────────────

  if (syncPlan.ready) {
    return syncPlan;
  }

  return asyncUrls.length > 0
    ? { urls: asyncUrls, ready: true }
    : { urls: [], ready: false };
}
