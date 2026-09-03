import { useSessionRuntime } from '@/hooks/useSessionRuntime';
import type { AttachInfo } from '../types';
import type { AddressPlan } from './useAddressPlan';
import type { P2PConnection } from '@/services/socket/p2pTypes';

interface UseP2PAttachTransportOptions {
  attachInfo: AttachInfo | null;
  sessionName: string;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  /** Session-first waits for xterm transport before attach. Legacy attaches on socket connect. */
  transportFirst?: boolean;
}

interface UseP2PAttachTransportResult {
  addressPlan: AddressPlan;
  activeUrl: string | null;
  p2pConnection: P2PConnection | null;
  p2pState: import('@/services/socket/types').ConnectionState;
  waitingForAddressPlan: boolean;
  fileOps: import('@/services/fileOps').FileOps | null;
  runtime: import('@/runtime/SessionRuntime').SessionRuntime | null;
}

/**
 * P2P attach transport: address rotation + relay fallback via shared SessionRuntime.
 */
export function useP2PAttachTransport({
  transportFirst = false,
}: UseP2PAttachTransportOptions): UseP2PAttachTransportResult {
  const { addressPlan, activeUrl, p2pConnection, p2pState, waitingForAddressPlan, fileOps, runtime } = useSessionRuntime({
    transportFirst,
  });

  return {
    addressPlan,
    activeUrl,
    p2pConnection,
    p2pState,
    waitingForAddressPlan,
    fileOps,
    runtime,
  };
}
