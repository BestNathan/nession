import { useEffect, useRef, useState } from 'react';
import type { AttachInfo, ProbedAddress } from '../types';
import { orderAddressesByLatency } from '../services/addressSelection';

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
 */
export function useAddressPlan(
  attachInfo: AttachInfo | null,
  { orderedUrls, manualUrl }: AddressPlanInput,
): AddressPlan {
  const [plan, setPlan] = useState<AddressPlan>({ urls: [], ready: false });

  // Serialise every input into one stable string. Callers pass fresh attachInfo
  // objects / orderedUrls arrays each render, so the effect must key on values,
  // not identities (else it re-runs → setState → re-render → loop).
  const mode = attachInfo?.mode ?? null;
  const sessionId = attachInfo?.session_id ?? null;
  const agentAddress = attachInfo?.agent_address ?? null;
  const candidates: ProbedAddress[] = attachInfo?.addresses ?? [];
  const candidateUrls = candidates.map((a) => a.url).join(',');
  const orderedKey = orderedUrls ? orderedUrls.join(',') : null;
  const planKey = `${mode}|${sessionId}|${manualUrl ?? ''}|${orderedKey ?? ''}|${agentAddress ?? ''}|${candidateUrls}`;

  // Stash the latest non-primitive inputs so the effect (which depends only on
  // planKey) can read current values without listing them as dependencies.
  const inputsRef = useRef({ orderedUrls, manualUrl, candidates, agentAddress, mode });
  inputsRef.current = { orderedUrls, manualUrl, candidates, agentAddress, mode };

  const activeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const inputs = inputsRef.current;
    if (inputs.mode !== 'p2p') {
      setPlan({ urls: [], ready: true });
      return;
    }

    activeKeyRef.current = planKey;

    // 1. Manual selection: use exactly that address, no rotation.
    if (inputs.manualUrl) {
      setPlan({ urls: [inputs.manualUrl], ready: true });
      return;
    }

    // 2. Pre-resolved order from the attach dialog's browser test. An EMPTY
    //    array is NOT a valid pre-resolved plan — it means the dialog had no
    //    cached probe yet (probe still racing, expired, or transiently failed).
    //    Treating [] as authoritative would resolve to zero URLs → activeUrl
    //    null → P2P never starts AND relay fallback never fires (it only
    //    triggers on a 'disconnected' transition that can't happen with no
    //    connection). Fall through to path 3 instead so we still derive
    //    candidates from attachInfo.
    if (inputs.orderedUrls && inputs.orderedUrls.length > 0) {
      setPlan({ urls: inputs.orderedUrls, ready: true });
      return;
    }

    // 3. Fallback: no pre-resolved list. Browser-test the candidates here.
    if (inputs.candidates.length === 0) {
      setPlan({ urls: inputs.agentAddress ? [inputs.agentAddress] : [], ready: true });
      return;
    }

    setPlan({ urls: [], ready: false });
    let cancelled = false;
    void orderAddressesByLatency(inputs.candidates).then((urls) => {
      if (cancelled || activeKeyRef.current !== planKey) {
        return;
      }
      const finalUrls =
        urls.length > 0 ? urls : inputs.agentAddress ? [inputs.agentAddress] : [];
      setPlan({ urls: finalUrls, ready: true });
    });

    return () => {
      cancelled = true;
    };
  }, [planKey]);

  return plan;
}
