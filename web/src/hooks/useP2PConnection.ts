import { useEffect, useRef, useCallback, useState } from 'react';

export interface P2PMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: any;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

type MessageHandler = (msg: P2PMessage) => void;

export interface P2PConnection {
  sendMessage: (msg: Record<string, unknown>) => void;
  onMessage: (handler: MessageHandler) => () => void;
  connectionState: ConnectionState;
  close: () => void;
}

interface UseP2PConnectionOptions {
  agentUrl: string;
  connectionToken?: string;
  sessionName: string;
  /** Called when a WebSocket error occurs before connection is established. */
  onError?: (error: Error) => void;
}

/**
 * Manages a P2P WebSocket connection to an agent for both terminal I/O
 * and file operations. The connection lifecycle is tied to component mount.
 * Returns null if options is null (relay mode).
 */
export function useP2PConnection(
  options: UseP2PConnectionOptions | null,
): P2PConnection | null {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const activeRef = useRef(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    if (!options) return;
    activeRef.current = true;

    const wsUrl = options.connectionToken
      ? `${options.agentUrl}${options.agentUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(options.connectionToken)}`
      : options.agentUrl;

    console.log('[P2P] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';
    setConnectionState('connecting');

    ws.onopen = () => {
      if (!activeRef.current) {
        ws.close();
        return;
      }
      console.log('[P2P] Connected');
      setConnectionState('connected');
    };

    ws.onmessage = (event) => {
      if (!activeRef.current) return;
      try {
        if (typeof event.data === 'string') {
          const msg: P2PMessage = JSON.parse(event.data);
          handlersRef.current.forEach((handler) => {
            try {
              handler(msg);
            } catch (e) {
              console.error('[P2P] Handler error:', e);
            }
          });
        } else if (event.data instanceof ArrayBuffer) {
          // Binary data — dispatch as a synthetic message so handlers
          // receive it through the same channel.
          const msg: P2PMessage = {
            msg_type: '__binary__',
            id: '',
            timestamp: 0,
            payload: event.data,
          };
          handlersRef.current.forEach((handler) => {
            try {
              handler(msg);
            } catch (e) {
              console.error('[P2P] Handler error:', e);
            }
          });
        }
      } catch (err) {
        console.error('[P2P] Message parse error:', err);
      }
    };

    ws.onerror = (event) => {
      console.error('[P2P] WebSocket error:', event);
      if (activeRef.current) {
        options.onError?.(new Error('P2P WebSocket connection error'));
      }
    };

    ws.onclose = () => {
      console.log('[P2P] WebSocket closed');
      if (activeRef.current) {
        setConnectionState('disconnected');
      }
    };

    return () => {
      activeRef.current = false;
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
      // Clear handler set so any stale handlers aren't kept in memory.
      handlersRef.current.clear();
    };
  }, [options?.agentUrl, options?.connectionToken, options?.sessionName]);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    } catch {
      // Send failed — the connection will be cleaned up on close.
    }
  }, []);

  const onMessage = useCallback((handler: MessageHandler): (() => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const close = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionState('disconnected');
  }, []);

  if (!options) return null;
  return { sendMessage, onMessage, connectionState, close };
}
