import { useEffect, useRef, useState } from 'react';
import type { AttachInfo } from '../types';
import { useP2PConnection, type P2PConnection } from './useP2PConnection';
import { useAddressPlan } from './useAddressPlan';

export interface P2PFallbackResult {
  /** Live P2P connection (null in relay mode or while auto-selecting). */
  p2pConnection: P2PConnection | null;
  /** Transport mode after any relay fallback. */
  effectiveMode: 'p2p' | 'relay';
  /** Currently active P2P URL (null in relay / while selecting). */
  activeUrl: string | null;
  /** True once every P2P address failed and we fell back to relay. */
  forcedRelay: boolean;
  /** Current manual address override (null = automatic). */
  manualOverride: string | null;
  /** Set/clear the manual address override. */
  setManualOverride: (url: string | null) => void;
}

interface UseP2PWithFallbackOptions {
  /**
   * Browser-tested candidate URLs from the attach dialog, best-first. Used
   * verbatim (no re-testing). `null` → resolve inside useAddressPlan.
   */
  orderedUrls: string[] | null;
  /** Initial manual address override (null = automatic). */
  initialSelectedAddress: string | null;
}

/**
 * Drive P2P connection with multi-address selection and fallback (issue #43):
 *
 * 1. Use the ordered candidate endpoints resolved by the attach dialog's
 *    browser latency test (or a manual override).
 * 2. Connect to the best candidate; on permanent disconnect, rotate to the
 *    next candidate.
 * 3. When all candidates are exhausted, fall back to relay so the session
 *    stays usable.
 *
 * Returns the connection plus the effective mode and selection state for the
 * terminal + header UI to consume.
 */
export function useP2PWithFallback(
  attachInfo: AttachInfo,
  sessionName: string,
  { orderedUrls, initialSelectedAddress }: UseP2PWithFallbackOptions,
): P2PFallbackResult {
  const [manualOverride, setManualOverride] = useState<string | null>(
    initialSelectedAddress,
  );

  // Reset manualOverride when the session changes so a manually-selected
  // address from session-1 on agent-1 doesn't carry over to session-2 on
  // agent-2. The ref keeps current initialSelectedAddress reachable without
  // listing it as an effect dependency (which would fire on every render).
  const initialSelectedRef = useRef(initialSelectedAddress);
  initialSelectedRef.current = initialSelectedAddress;
  useEffect(() => {
    setManualOverride(initialSelectedRef.current);
  }, [attachInfo.session_id]);

  // When a manual override is active it wins; otherwise use the dialog's
  // browser-tested order.
  const plan = useAddressPlan(attachInfo, { orderedUrls, manualUrl: manualOverride });
  const [addressIndex, setAddressIndex] = useState(0);
  const [forcedRelay, setForcedRelay] = useState(false);

  // A new attach (or re-planned addresses) resets rotation + relay fallback.
  // Key on the URL list as a stable string so the effect only fires when the
  // candidate set actually changes, not on every identity-stable re-render.
  const planUrlsKey = plan.urls.join(',');
  useEffect(() => {
    setAddressIndex(0);
    setForcedRelay(false);
  }, [planUrlsKey]);

  const isP2P = attachInfo.mode === 'p2p' && !forcedRelay;
  const activeUrl = isP2P && plan.ready ? (plan.urls[addressIndex] ?? null) : null;
  const hasMoreCandidates = addressIndex + 1 < plan.urls.length;

  const p2pConnection = useP2PConnection(
    isP2P && activeUrl
      ? {
          agentUrl: activeUrl,
          connectionToken: attachInfo.connection_token,
          sessionName,
          // While other candidates remain, give up quickly (2 attempts) so we
          // rotate fast. On the last candidate, use the full backoff budget so
          // a flaky-but-working endpoint gets a fair chance before relay.
          maxReconnectAttempts: hasMoreCandidates ? 2 : 10,
        }
      : null,
  );

  // Fallback driver: when the active P2P endpoint gives up, advance to the next
  // candidate; when none remain, switch to relay.
  //
  // `useP2PConnection` initialises its state to 'disconnected' when first
  // rendered with null options (before the address plan resolves). Guard
  // against that stale value: only treat 'disconnected' as failure once the
  // connection for the *current* address has actually gone live (reached
  // 'connecting'/'connected'/'reconnecting'). `startedRef` is keyed by the
  // active URL + index so each new candidate re-arms the guard.
  const p2pState = p2pConnection?.connectionState;
  const startedRef = useRef<string | null>(null);
  const attemptKey = `${addressIndex}:${activeUrl ?? ''}`;
  useEffect(() => {
    if (!isP2P || !plan.ready || !activeUrl) {
      return;
    }
    if (p2pState && p2pState !== 'disconnected') {
      startedRef.current = attemptKey;
      return;
    }
    // p2pState === 'disconnected': only a real failure if this attempt was
    // already observed live. Otherwise it's the pre-connect stale state.
    if (p2pState === 'disconnected' && startedRef.current === attemptKey) {
      if (addressIndex + 1 < plan.urls.length) {
        console.log(`[P2P] Address ${plan.urls[addressIndex]} failed; trying next candidate`);
        setAddressIndex((i) => i + 1);
      } else {
        console.log('[P2P] All addresses exhausted; falling back to relay');
        setForcedRelay(true);
      }
    }
  }, [isP2P, plan, activeUrl, attemptKey, p2pState, addressIndex]);

  return {
    p2pConnection,
    effectiveMode: isP2P ? 'p2p' : 'relay',
    activeUrl,
    forcedRelay,
    manualOverride,
    setManualOverride,
  };
}
