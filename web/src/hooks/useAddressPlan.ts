import { useEffect, useRef, useState } from 'react';
import type { AttachInfo } from '../types';
import { orderAddressesByLatency } from '../services/addressSelection';

/** Outcome of resolving which P2P endpoint(s) to try for an attach. */
export interface AddressPlan {
  /** Ordered candidate URLs to attempt, best-first. */
  urls: string[];
  /** True once auto-selection latency testing has finished (or was skipped). */
  ready: boolean;
}

/**
 * Resolve the ordered list of P2P URLs to attempt for a session attach.
 *
 * - Manual override (`manualUrl`): a single-entry plan, no latency testing.
 * - Auto: latency-test `attachInfo.addresses` and order best-first. Falls back
 *   to the legacy single `agent_address` when the server sent no address list
 *   (old server / old agent).
 *
 * The plan is computed once per attach (keyed on session id + manual choice);
 * rotation through it on failure is the caller's concern.
 */
export function useAddressPlan(
  attachInfo: AttachInfo | null,
  manualUrl: string | null,
): AddressPlan {
  const [plan, setPlan] = useState<AddressPlan>({ urls: [], ready: false });
  // Guard against setting state after unmount / a superseded attach.
  const attachKey = attachInfo
    ? `${attachInfo.session_id}|${manualUrl ?? 'auto'}`
    : null;
  const activeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!attachInfo || attachInfo.mode !== 'p2p' || !attachKey) {
      setPlan({ urls: [], ready: true });
      return;
    }

    activeKeyRef.current = attachKey;

    // Manual selection: skip latency testing, use exactly that address.
    if (manualUrl) {
      setPlan({ urls: [manualUrl], ready: true });
      return;
    }

    const candidates = attachInfo.addresses ?? [];
    // No candidate list from the server: fall back to the legacy single URL.
    if (candidates.length === 0) {
      const legacy = attachInfo.agent_address ? [attachInfo.agent_address] : [];
      setPlan({ urls: legacy, ready: true });
      return;
    }

    // Auto mode: test latency across candidates, then order best-first.
    setPlan({ urls: [], ready: false });
    let cancelled = false;
    void orderAddressesByLatency(candidates).then((urls) => {
      if (cancelled || activeKeyRef.current !== attachKey) {
        return;
      }
      // If every candidate failed the handshake test, still fall back to the
      // legacy single address so a transiently-failing test doesn't force relay.
      const finalUrls =
        urls.length > 0
          ? urls
          : attachInfo.agent_address
            ? [attachInfo.agent_address]
            : [];
      setPlan({ urls: finalUrls, ready: true });
    });

    return () => {
      cancelled = true;
    };
  }, [attachInfo, attachKey, manualUrl]);

  return plan;
}
