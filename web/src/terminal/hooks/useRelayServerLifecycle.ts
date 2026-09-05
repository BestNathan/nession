import { useEffect, useState } from 'react';
import type { ConnectionState } from '@/services/socket/types';
import type { RelayServerHandle } from '@/runtime/relayServerConnection';
import type { TerminalStatus } from '@/terminal/state/session';

interface UseRelayServerLifecycleOptions {
  effectiveMode: 'p2p' | 'relay';
  serverConnection?: RelayServerHandle;
  setTerminalState: (update: TerminalStatus | ((prev: TerminalStatus) => TerminalStatus)) => void;
}

/**
 * Legacy TerminalWorkspace relay server-ws lifecycle.
 *
 * On the new transport the server WebSocket reports 'reconnecting' through
 * its intra-budget reconnect — 'disconnected' only fires once the budget is
 * exhausted. Either ends the server-side relay forwarding loop, so both are
 * a recoverable loss for the attach machine. `relayLost` (the "Connection
 * lost" banner) is only for the budget-exhausted 'disconnected'.
 *
 * The post-handshake 'connected' handoff (old 'authenticated') promotes
 * connecting/reconnecting/failed to 'connected'; the attach machine's
 * 'connected' case then re-begins relay exactly once per reconnect cycle.
 */
export function useRelayServerLifecycle({
  effectiveMode,
  serverConnection,
  setTerminalState,
}: UseRelayServerLifecycleOptions): { relayLost: boolean } {
  const [relayLost, setRelayLost] = useState(false);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !serverConnection) {
      return;
    }
    return serverConnection.onConnectionStateChange((state: ConnectionState) => {
      if (state === 'connected') {
        setRelayLost(false);
        setTerminalState((prev) => {
          if (prev === 'connecting' || prev === 'reconnecting' || prev === 'failed') {
            return 'connected';
          }
          return prev;
        });
      } else if (state === 'connecting' || state === 'reconnecting') {
        // Recoverable (intra-budget) loss — relay loop is gone, but the server
        // may re-handshake without the browser ever seeing 'disconnected'.
        // ('connecting' fires for the initial attempt too, where the terminal
        // is idle/connecting and this is a no-op.)
        setTerminalState((prev) => {
          if (prev === 'attached' || prev === 'connected') {
            return 'reconnecting';
          }
          return prev;
        });
      } else if (state === 'disconnected') {
        setRelayLost(true);
        setTerminalState((prev) => {
          if (prev === 'attached' || prev === 'connected') {
            return 'reconnecting';
          }
          return prev;
        });
      }
    });
  }, [effectiveMode, serverConnection, setTerminalState]);

  return { relayLost };
}
