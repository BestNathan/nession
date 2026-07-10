import { useEffect, useState } from 'react';
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

/**
 * Drive P2P connection with multi-address selection and fallback (issue #43):
 *
 * 1. Resolve an ordered list of candidate endpoints (auto latency test, or a
 *    manual override).
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
  initialSelectedAddress: string | null,
): P2PFallbackResult {
  const [manualOverride, setManualOverride] = useState<string | null>(
    initialSelectedAddress,
  );
  const plan = useAddressPlan(attachInfo, manualOverride);
  const [addressIndex, setAddressIndex] = useState(0);
  const [forcedRelay, setForcedRelay] = useState(false);

  // A new attach (or re-planned addresses) resets rotation + relay fallback.
  useEffect(() => {
    setAddressIndex(0);
    setForcedRelay(false);
  }, [plan]);

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
  const p2pState = p2pConnection?.connectionState;
  useEffect(() => {
    if (!isP2P || !plan.ready || p2pState !== 'disconnected') {
      return;
    }
    if (addressIndex + 1 < plan.urls.length) {
      console.log(`[P2P] Address ${plan.urls[addressIndex]} failed; trying next candidate`);
      setAddressIndex((i) => i + 1);
    } else {
      console.log('[P2P] All addresses exhausted; falling back to relay');
      setForcedRelay(true);
    }
  }, [isP2P, plan, p2pState, addressIndex]);

  return {
    p2pConnection,
    effectiveMode: isP2P ? 'p2p' : 'relay',
    activeUrl,
    forcedRelay,
    manualOverride,
    setManualOverride,
  };
}
