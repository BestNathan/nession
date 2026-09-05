import { useSessionRuntime } from '@/hooks/useSessionRuntime';
import type { AttachInfo } from '../types';
import type { AddressPlan } from './useAddressPlan';
import type { TerminalAgentApi } from '@/features/terminal';
import type { RelayServerHandle } from '@/runtime/relayServerConnection';

interface UseP2PAttachTransportOptions {
  attachInfo: AttachInfo | null;
  sessionName: string;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  /** Relay-mode server connection handle (see relayServerHandle). */
  serverConnection?: RelayServerHandle;
}

interface UseP2PAttachTransportResult {
  addressPlan: AddressPlan;
  activeUrl: string | null;
  /** Live agent terminal capability of the current P2P transport (null in relay). */
  agentTerminalApi: TerminalAgentApi | null;
  /** Agent-transport connection state, gated 'disconnected' outside the P2P transport. */
  connectionState: import('@/services/socket/types').ConnectionState;
  waitingForAddressPlan: boolean;
  fileOps: import('@/features/files').FileOps | null;
  runtime: import('@/runtime/SessionRuntime').SessionRuntime | null;
  transportKey: string | null;
  snapshot: import('@/runtime/SessionRuntime').SessionRuntimeSnapshot | null;
}

/**
 * P2P attach transport: address rotation + relay fallback via shared SessionRuntime.
 */
export function useP2PAttachTransport({
  serverConnection,
}: UseP2PAttachTransportOptions): UseP2PAttachTransportResult {
  const {
    addressPlan, activeUrl, agentTerminalApi, connectionState,
    waitingForAddressPlan, fileOps, runtime, snapshot, transportKey,
  } = useSessionRuntime({
    configOwner: true,
    serverConnection,
  });

  return {
    addressPlan,
    activeUrl,
    agentTerminalApi,
    connectionState,
    waitingForAddressPlan,
    fileOps,
    runtime,
    transportKey,
    snapshot,
  };
}
