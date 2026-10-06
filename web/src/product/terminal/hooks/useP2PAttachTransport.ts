import { useSessionRuntime } from '@/product/terminal/hooks/useSessionRuntime';
import type { AttachInfo } from '@/types';
import type { TerminalAgentApi } from '@/product/terminal';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';

interface UseP2PAttachTransportOptions {
  attachInfo: AttachInfo | null;
  sessionName: string;
  orderedUrls: string[] | null;
  manualOverride: string | null;
  /** Relay-mode server connection handle (see relayServerHandle). */
  serverConnection?: RelayServerTransport;
  /** Whether the Terminal already holds this session's history (#321). */
  hasSessionOutput?: () => boolean;
}

interface UseP2PAttachTransportResult {
  activeUrl: string | null;
  /** Live agent terminal capability of the current P2P transport (null in relay). */
  agentTerminalApi: TerminalAgentApi | null;
  /** Agent-transport connection state, gated 'disconnected' outside the P2P transport. */
  connectionState: import('@/platform/socket/types').ConnectionState;
  fileOps: import('@/capabilities/files').FileOps | null;
  runtime: import('@/platform/session-runtime/SessionRuntime').SessionRuntime | null;
  snapshot: import('@/platform/session-runtime/SessionRuntime').SessionRuntimeSnapshot | null;
}

/**
 * P2P attach transport: address rotation + relay fallback via shared SessionRuntime.
 */
export function useP2PAttachTransport({
  serverConnection,
  hasSessionOutput,
}: UseP2PAttachTransportOptions): UseP2PAttachTransportResult {
  const {
    activeUrl, agentTerminalApi, connectionState,
    fileOps, runtime, snapshot,
  } = useSessionRuntime({
    configOwner: true,
    serverConnection,
    hasSessionOutput,
  });

  return {
    activeUrl,
    agentTerminalApi,
    connectionState,
    fileOps,
    runtime,
    snapshot,
  };
}
