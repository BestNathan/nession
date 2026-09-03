import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { p2pStateAtom, p2pConnectionAtom, p2pEpochAtom } from '../atoms/connection';
import { AgentSocketClient } from '@/services/socket/AgentSocketClient';
import { createP2PConnectionAdapter } from '@/services/socket/P2PConnectionAdapter';

export type { P2PConnection, P2PConnectionState as ConnectionState, P2PMessage } from '@/services/socket/p2pTypes';
import type { P2PConnection, P2PConnectionState as ConnectionState } from '@/services/socket/p2pTypes';

interface UseP2PConnectionOptions {
  agentUrl: string;
  connectionToken?: string;
  sessionName: string;
  onError?: (error: Error) => void;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
}

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_DELAY = 1_000;

function makeStubConnection(
  connectionStateRef?: { current: ConnectionState },
  reconnectAttemptRef?: { current: number },
): P2PConnection {
  return {
    sendMessage: () => {},
    onMessage: () => () => {},
    close: () => {},
    waitForConnection: () => Promise.reject(new Error('Connection lost')),
    get connectionState() { return connectionStateRef?.current ?? 'disconnected'; },
    get reconnectAttempt() { return reconnectAttemptRef?.current ?? 0; },
  };
}

function useTransportReset(
  agentUrl: string | undefined,
  connectionToken: string | undefined,
  connectionState: ConnectionState,
  setConnectionState: (s: ConnectionState) => void,
): void {
  const prevAgentUrlRef = useRef<string | undefined>(undefined);
  if (agentUrl && agentUrl !== prevAgentUrlRef.current) {
    setConnectionState('connecting');
  }
  if (!agentUrl && prevAgentUrlRef.current && connectionState !== 'disconnected') {
    setConnectionState('disconnected');
  }
  prevAgentUrlRef.current = agentUrl;

  const prevConnectionTokenRef = useRef<string | undefined>(undefined);
  if (
    connectionToken
    && connectionToken !== prevConnectionTokenRef.current
    && prevConnectionTokenRef.current !== undefined
  ) {
    setConnectionState('connecting');
  }
  prevConnectionTokenRef.current = connectionToken;
}

/**
 * Standalone P2P adapter hook — prefer {@link useSessionRuntime} for production paths.
 * Owns an {@link AgentSocketClient} instead of a raw browser WebSocket.
 */
export function useP2PConnection(
  options: UseP2PConnectionOptions | null,
): P2PConnection | null {
  const clientRef = useRef<AgentSocketClient | null>(null);
  const connectionRef = useRef<P2PConnection>(makeStubConnection());
  const [adapterGeneration, setAdapterGeneration] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    options?.agentUrl ? 'connecting' : 'disconnected',
  );
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const setP2pState = useSetAtom(p2pStateAtom);
  const setP2pConnection = useSetAtom(p2pConnectionAtom);
  const p2pEpoch = useAtomValue(p2pEpochAtom);
  const hasP2pTarget = Boolean(options);

  const agentUrl = options?.agentUrl;
  const connectionToken = options?.connectionToken;
  const onError = options?.onError;
  const maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const reconnectBaseDelay = options?.reconnectBaseDelay ?? DEFAULT_BASE_DELAY;

  useTransportReset(agentUrl, connectionToken, connectionState, setConnectionState);

  const connectionStateRef = useRef<ConnectionState>(connectionState);
  connectionStateRef.current = connectionState;
  const reconnectAttemptRef = useRef(reconnectAttempt);
  reconnectAttemptRef.current = reconnectAttempt;

  useEffect(() => {
    if (!agentUrl) {
      clientRef.current?.dispose();
      clientRef.current = null;
      connectionRef.current = makeStubConnection(connectionStateRef, reconnectAttemptRef);
      setAdapterGeneration((g) => g + 1);
      return;
    }

    const client = new AgentSocketClient({
      agentUrl,
      connectionToken,
      maxReconnectAttempts,
      reconnectBaseDelay,
      onError,
    });
    clientRef.current = client;
    connectionRef.current = createP2PConnectionAdapter(client);
    setAdapterGeneration((g) => g + 1);

    const unsub = client.onConnectionStateChange((state) => {
      connectionStateRef.current = state;
      reconnectAttemptRef.current = client.reconnectAttempts;
      setConnectionState(state);
      setP2pState(state);
      setReconnectAttempt(client.reconnectAttempts);
    });

    client.connect();

    return () => {
      unsub();
      client.dispose();
      clientRef.current = null;
      connectionRef.current = makeStubConnection(connectionStateRef, reconnectAttemptRef);
    };
  }, [agentUrl, connectionToken, maxReconnectAttempts, reconnectBaseDelay, onError, setP2pState]);

  const connection = useMemo<P2PConnection>(() => {
    void p2pEpoch;
    void adapterGeneration;
    const inner = connectionRef.current;
    return {
      sendMessage: (msg) => inner.sendMessage(msg),
      onMessage: (handler) => inner.onMessage(handler),
      close: () => inner.close(),
      waitForConnection: (timeoutMs) => {
        if (connectionStateRef.current === 'connected') {
          return Promise.resolve();
        }
        if (connectionStateRef.current === 'disconnected') {
          return Promise.reject(new Error('Connection lost'));
        }
        const client = clientRef.current;
        if (client) {
          return client.waitForConnection(timeoutMs);
        }
        const budget = timeoutMs ?? 15_000;
        return new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + budget;
          const poll = () => {
            if (connectionStateRef.current === 'connected') {
              resolve();
              return;
            }
            if (connectionStateRef.current === 'disconnected') {
              reject(new Error('Connection lost'));
              return;
            }
            const live = clientRef.current;
            if (live) {
              void live.waitForConnection(Math.max(500, deadline - Date.now())).then(resolve).catch(reject);
              return;
            }
            if (Date.now() >= deadline) {
              reject(new Error('Connection timeout'));
              return;
            }
            queueMicrotask(poll);
          };
          poll();
        });
      },
      get connectionState() { return connectionStateRef.current; },
      get reconnectAttempt() { return reconnectAttemptRef.current; },
    };
  }, [p2pEpoch, adapterGeneration]);

  useLayoutEffect(() => {
    if (hasP2pTarget) {
      setP2pConnection(connection);
    }
    return () => {
      setP2pConnection(null);
      setP2pState('disconnected');
    };
  }, [connection, hasP2pTarget, setP2pConnection, setP2pState]);

  if (!options) {
    return null;
  }
  return connection;
}
