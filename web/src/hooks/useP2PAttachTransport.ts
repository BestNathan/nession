import { useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { AttachInfo } from '../types';
import { p2pEpochAtom } from '../atoms/connection';
import { forcedRelayAtom } from '../atoms/session';
import { terminalSessionStateAtom } from '../terminal/state/session';
import { useP2PConnection, type P2PConnection } from './useP2PConnection';
import { useAddressPlan, type AddressPlan } from './useAddressPlan';

interface UseP2PAttachTransportOptions {
  attachInfo: AttachInfo | null;
  sessionName: string;
  orderedUrls: string[] | null;
  manualOverride: string | null;
}

interface UseP2PAttachTransportResult {
  addressPlan: AddressPlan;
  activeUrl: string | null;
  p2pConnection: P2PConnection | null;
  waitingForAddressPlan: boolean;
}

/**
 * P2P attach transport: address rotation + relay fallback.
 * Restores the behaviour removed with useP2PWithFallback (jotai migration).
 */
export function useP2PAttachTransport({
  attachInfo,
  sessionName,
  orderedUrls,
  manualOverride,
}: UseP2PAttachTransportOptions): UseP2PAttachTransportResult {
  const [forcedRelayState, setForcedRelayState] = useAtom(forcedRelayAtom);
  const setP2pEpoch = useSetAtom(p2pEpochAtom);
  const setTerminalState = useSetAtom(terminalSessionStateAtom);
  const forcedRelay = manualOverride ? false : forcedRelayState;

  const addressPlan = useAddressPlan(attachInfo, { orderedUrls, manualUrl: manualOverride });
  const [addressIndex, setAddressIndex] = useState(0);

  const planUrlsKey = addressPlan.urls.join(',');
  useEffect(() => {
    setAddressIndex(0);
    setForcedRelayState(false);
  }, [planUrlsKey, setForcedRelayState]);

  const prevManualRef = useRef(manualOverride);
  useEffect(() => {
    const prev = prevManualRef.current;
    prevManualRef.current = manualOverride;
    if (manualOverride && !prev) {
      setForcedRelayState(false);
    }
  }, [manualOverride, setForcedRelayState]);

  const isP2P = attachInfo?.mode === 'p2p' && !forcedRelay;
  const activeUrl = isP2P && addressPlan.ready ? (addressPlan.urls[addressIndex] ?? null) : null;
  const hasMoreCandidates = addressIndex + 1 < addressPlan.urls.length;
  const singleLegacyFallback =
    !manualOverride
    && addressPlan.urls.length === 1
    && addressPlan.urls[0] === attachInfo?.agent_address
    && (orderedUrls === null || orderedUrls.length === 0);

  const p2pConnection = useP2PConnection(
    isP2P && activeUrl && attachInfo
      ? {
          agentUrl: activeUrl,
          connectionToken: attachInfo.connection_token,
          sessionName,
          maxReconnectAttempts: manualOverride
            ? 2
            : (hasMoreCandidates ? 2 : (singleLegacyFallback ? 2 : 10)),
        }
      : null,
  );

  const p2pState = p2pConnection?.connectionState;
  const startedRef = useRef<string | null>(null);
  const attemptKey = `${addressIndex}:${activeUrl ?? ''}`;
  useEffect(() => {
    if (!isP2P || !addressPlan.ready || !activeUrl) {
      return;
    }
    if (p2pState && p2pState !== 'disconnected') {
      startedRef.current = attemptKey;
      return;
    }
    if (p2pState === 'disconnected' && startedRef.current === attemptKey) {
      if (addressIndex + 1 < addressPlan.urls.length) {
        console.log(`[P2P] Address ${addressPlan.urls[addressIndex]} failed; trying next candidate`);
        setP2pEpoch((epoch) => epoch + 1);
        setTerminalState('connecting');
        setAddressIndex((i) => i + 1);
      } else if (!manualOverride) {
        console.log('[P2P] All addresses exhausted; falling back to relay');
        setP2pEpoch((epoch) => epoch + 1);
        setTerminalState('connecting');
        setForcedRelayState(true);
      }
    }
  }, [
    isP2P,
    addressPlan,
    activeUrl,
    attemptKey,
    p2pState,
    addressIndex,
    manualOverride,
    setForcedRelayState,
    setP2pEpoch,
    setTerminalState,
  ]);

  return {
    addressPlan,
    activeUrl,
    p2pConnection: isP2P ? p2pConnection : null,
    waitingForAddressPlan: isP2P && !addressPlan.ready,
  };
}
