import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '@/types';
import type { WebSocketService } from '@/services/websocket';
import type { TerminalStatus } from '@/terminal/state/session';

interface UseRelayServerLifecycleOptions {
  effectiveMode: 'p2p' | 'relay';
  wsService?: WebSocketService;
  setTerminalState: (update: TerminalStatus | ((prev: TerminalStatus) => TerminalStatus)) => void;
}

/**
 * Legacy TerminalWorkspace relay server-ws lifecycle.
 *
 * The server WebSocket core stays in `connecting` through its intra-budget
 * reconnect — `disconnected` only fires once the budget is exhausted. Either
 * ends the server-side relay forwarding loop, so both are a recoverable loss
 * for the attach machine. `relayLost` (the "Connection lost" banner) is only
 * for the terminal, budget-exhausted `disconnected`.
 *
 * The `authenticated` handoff promotes connecting/reconnecting/failed to
 * `connected`; the attach machine's `connected` case then re-begins relay
 * exactly once per reconnect cycle.
 */
export function useRelayServerLifecycle({
  effectiveMode,
  wsService,
  setTerminalState,
}: UseRelayServerLifecycleOptions): { relayLost: boolean } {
  const [relayLost, setRelayLost] = useState(false);

  useEffect(() => {
    if (effectiveMode !== 'relay' || !wsService) {
      return;
    }
    return wsService.onConnectionChange((status: ConnectionStatus) => {
      if (status === 'authenticated') {
        setRelayLost(false);
        setTerminalState((prev) => {
          if (prev === 'connecting' || prev === 'reconnecting' || prev === 'failed') {
            return 'connected';
          }
          return prev;
        });
      } else if (status === 'connecting') {
        // Recoverable (intra-budget) loss — relay loop is gone, but the server
        // may re-authenticate without the browser ever seeing 'disconnected'.
        setTerminalState((prev) => {
          if (prev === 'attached' || prev === 'connected') {
            return 'reconnecting';
          }
          return prev;
        });
      } else if (status === 'disconnected') {
        setRelayLost(true);
        setTerminalState((prev) => {
          if (prev === 'attached' || prev === 'connected') {
            return 'reconnecting';
          }
          return prev;
        });
      }
    });
  }, [effectiveMode, wsService, setTerminalState]);

  return { relayLost };
}
