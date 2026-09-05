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
  /** Session-first waits for xterm transport before attach. Legacy attaches on socket connect. */
  transportFirst?: boolean;
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
  /** @deprecated Alias of connectionState — legacy consumers migrating. */
  p2pState: import('@/services/socket/types').ConnectionState;
  waitingForAddressPlan: boolean;
  fileOps: import('@/services/fileOps').FileOps | null;
  runtime: import('@/runtime/SessionRuntime').SessionRuntime | null;
  transportKey: string | null;
  snapshot: import('@/runtime/SessionRuntime').SessionRuntimeSnapshot | null;
}

/**
 * P2P attach transport: address rotation + relay fallback via shared SessionRuntime.
 */
export function useP2PAttachTransport({
  transportFirst = true,
  serverConnection,
}: UseP2PAttachTransportOptions): UseP2PAttachTransportResult {
  const {
    addressPlan, activeUrl, agentTerminalApi, connectionState, p2pState,
    waitingForAddressPlan, fileOps, runtime, snapshot, transportKey,
  } = useSessionRuntime({
    transportFirst,
    configOwner: true,
    serverConnection,
  });

  return {
    addressPlan,
    activeUrl,
    agentTerminalApi,
    connectionState,
    p2pState,
    waitingForAddressPlan,
    fileOps,
    runtime,
    transportKey,
    snapshot,
  };
}
