import { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo, type MutableRefObject } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { p2pStateAtom, p2pConnectionAtom, p2pEpochAtom } from '../atoms/connection';

export interface P2PMessage {
  msg_type: string;
  id: string;
  timestamp: number;
  payload: unknown;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

type MessageHandler = (msg: P2PMessage) => void;

export interface P2PConnection {
  sendMessage: (msg: Record<string, unknown>) => void;
  onMessage: (handler: MessageHandler) => () => void;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  close: () => void;
  /**
   * Resolves once the socket is connected, or rejects if it becomes
   * permanently disconnected / the wait times out. Lets callers (e.g. file
   * operations issued right after attach) queue until the transport is ready
   * instead of firing into a still-connecting socket.
   */
  waitForConnection: (timeoutMs?: number) => Promise<void>;
}

interface UseP2PConnectionOptions {
  agentUrl: string;
  connectionToken?: string;
  sessionName: string;
  onError?: (error: Error) => void;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
}

const MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BASE_DELAY = 1_000;

function buildWsUrl(agentUrl: string, connectionToken?: string): string {
  if (!connectionToken) {return agentUrl;}
  return `${agentUrl}${agentUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(connectionToken)}`;
}

/** Bundle of refs/state needed by connectWs to avoid excessive parameters. */
interface ConnectWsContext {
  agentUrl: string;
  connectionToken: string | undefined;
  generation: number;
  generationRef: React.MutableRefObject<number>;
  reconnectAttemptRef: React.MutableRefObject<number>;
  setConnectionState: (s: ConnectionState) => void;
  setP2pState: (s: ConnectionState) => void;
  setReconnectAttempt: (n: number) => void;
  handlersRef: React.MutableRefObject<Set<MessageHandler>>;
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
  onError: ((error: Error) => void) | undefined;
  reconnectTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  wsRef: React.MutableRefObject<WebSocket | null>;
  connectSelf: () => void;
}

/** Create a WebSocket connection wired to the hook's refs and state setters. */
function connectWs(ctx: ConnectWsContext) {
  const { generationRef } = ctx;
  const wsUrl = buildWsUrl(ctx.agentUrl, ctx.connectionToken);
  console.log('[P2P] Connecting to:', wsUrl);

  const ws = new WebSocket(wsUrl);
  ctx.wsRef.current = ws;
  ws.binaryType = 'arraybuffer';

  if (ctx.reconnectAttemptRef.current === 0) {
    ctx.setConnectionState('connecting');
  }

  ws.onopen = () => {
    if (generationRef.current !== ctx.generation) { ws.close(); return; }
    console.log('[P2P] Connected');
    ctx.reconnectAttemptRef.current = 0;
    ctx.setReconnectAttempt(0);
    ctx.setConnectionState('connected');
    ctx.setP2pState('connected');
  };

  ws.onmessage = (event) => {
    if (generationRef.current !== ctx.generation) {return;}
    try {
      if (typeof event.data === 'string') {
        const msg: P2PMessage = JSON.parse(event.data);
        ctx.handlersRef.current.forEach((h) => { try { h(msg); } catch (e) { console.error('[P2P] Handler error:', e); } });
      } else if (event.data instanceof ArrayBuffer) {
        const msg: P2PMessage = { msg_type: '__binary__', id: '', timestamp: 0, payload: event.data };
        ctx.handlersRef.current.forEach((h) => { try { h(msg); } catch (e) { console.error('[P2P] Handler error:', e); } });
      }
    } catch (err) { console.error('[P2P] Message parse error:', err); }
  };

  ws.onerror = () => {
    console.error('[P2P] WebSocket error');
    if (generationRef.current === ctx.generation && ctx.reconnectAttemptRef.current === 0) {
      ctx.onError?.(new Error('P2P WebSocket connection error'));
    }
  };

  ws.onclose = () => {
    console.log('[P2P] WebSocket closed');
    if (generationRef.current !== ctx.generation) {return;}
    const attempt = ctx.reconnectAttemptRef.current;
    if (attempt >= ctx.maxReconnectAttempts) {
      console.log('[P2P] Max reconnect attempts reached');
      ctx.setConnectionState('disconnected');
      ctx.setP2pState('disconnected');
      return;
    }
    ctx.setP2pState('reconnecting');
    ctx.setConnectionState('reconnecting');
    ctx.setReconnectAttempt(attempt + 1);
    ctx.reconnectAttemptRef.current = attempt + 1;

    const delay = Math.min(ctx.reconnectBaseDelay * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
    console.log(`[P2P] Scheduling reconnect in ${delay}ms (attempt ${attempt + 1}/${ctx.maxReconnectAttempts})`);

    ctx.reconnectTimerRef.current = setTimeout(() => {
      ctx.reconnectTimerRef.current = null;
      if (generationRef.current === ctx.generation) {ctx.connectSelf();}
    }, delay);
  };
}

/**
 * Resets connectionState when the P2P transport identity changes between
 * renders, using React's "adjust state during render" pattern so the committed
 * render — and therefore child effects like Terminal's Bridge — already see the
 * fresh state (an effect would run too late).
 *
 * - agentUrl appears or changes → 'connecting'
 * - agentUrl clears (relay fallback / plan re-resolve) → 'disconnected'
 * - connectionToken changes (session switch on the same agent) → 'connecting'
 *   (otherwise the stale 'connected' sends client.attach before the new socket
 *   opens, the message is dropped, and the attach stalls ~10s)
 */
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
    connectionToken &&
    connectionToken !== prevConnectionTokenRef.current &&
    prevConnectionTokenRef.current !== undefined
  ) {
    setConnectionState('connecting');
  }
  prevConnectionTokenRef.current = connectionToken;
}

/** Manage the agent WebSocket lifecycle (connect, reconnect, waiters). */
function useAgentWebSocket(opts: {
  agentUrl: string | undefined;
  connectionToken: string | undefined;
  connectionState: ConnectionState;
  setConnectionState: (s: ConnectionState) => void;
  setP2pState: (s: ConnectionState) => void;
  setReconnectAttempt: (n: number) => void;
  generationRef: MutableRefObject<number>;
  reconnectAttemptRef: MutableRefObject<number>;
  handlersRef: MutableRefObject<Set<MessageHandler>>;
  maxReconnectAttemptsRef: MutableRefObject<number>;
  reconnectBaseDelayRef: MutableRefObject<number>;
  onErrorRef: MutableRefObject<((error: Error) => void) | undefined>;
  reconnectTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  waitersRef: MutableRefObject<Set<{ resolve: () => void; reject: (e: Error) => void }>>;
}): void {
  const {
    agentUrl, connectionToken, connectionState,
    setConnectionState, setP2pState, setReconnectAttempt,
    generationRef, reconnectAttemptRef, handlersRef,
    maxReconnectAttemptsRef, reconnectBaseDelayRef, onErrorRef,
    reconnectTimerRef, wsRef, waitersRef,
  } = opts;

  useEffect(() => {
    if (!agentUrl) {return;}

    generationRef.current += 1;
    const myGeneration = generationRef.current;

    const ctx: ConnectWsContext = {
      agentUrl, connectionToken,
      generation: myGeneration,
      generationRef,
      reconnectAttemptRef,
      setConnectionState, setP2pState, setReconnectAttempt, handlersRef,
      maxReconnectAttempts: maxReconnectAttemptsRef.current,
      reconnectBaseDelay: reconnectBaseDelayRef.current,
      onError: onErrorRef.current,
      reconnectTimerRef, wsRef,
      connectSelf: () => connectWs(ctx),
    };
    connectWs(ctx);

    return () => {
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    };
  }, [
    agentUrl,
    connectionToken,
    setP2pState,
    setConnectionState,
    setReconnectAttempt,
    generationRef,
    reconnectAttemptRef,
    handlersRef,
    maxReconnectAttemptsRef,
    reconnectBaseDelayRef,
    onErrorRef,
    reconnectTimerRef,
    wsRef,
  ]);

  useEffect(() => {
    if (connectionState === 'connected') {
      const waiters = waitersRef.current;
      waitersRef.current = new Set();
      waiters.forEach((w) => w.resolve());
    } else if (connectionState === 'disconnected') {
      const waiters = waitersRef.current;
      waitersRef.current = new Set();
      waiters.forEach((w) => w.reject(new Error('Connection lost')));
    }
  }, [connectionState, waitersRef]);
}

/**
 * Manages a P2P WebSocket connection to an agent for both terminal I/O
 * and file operations. Returns null if options is null (relay mode).
 *
 * When the connection drops unexpectedly, the hook automatically attempts
 * reconnection with exponential backoff (1s → 2s → 4s → ... → 30s).
 */
export function useP2PConnection(
  options: UseP2PConnectionOptions | null,
): P2PConnection | null {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  // Generation counter — incremented each time agentUrl changes so stale
  // WebSocket events from cancelled connections can't update state.
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  // Start in 'connecting' when we have an agent to reach. Child effects (e.g.
  // FileBrowser's load-on-mount) run before this hook's connect effect, so an
  // initial 'disconnected' would make waitForConnection() reject before the
  // socket even starts. 'connecting' correctly makes those callers wait.
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    options?.agentUrl ? 'connecting' : 'disconnected',
  );
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const setP2pState = useSetAtom(p2pStateAtom);
  const setP2pConnection = useSetAtom(p2pConnectionAtom);
  // Bumped by switchAddressAtom on every route switch. Used only to change the
  // connection object's identity (see the useMemo below), never read directly.
  const p2pEpoch = useAtomValue(p2pEpochAtom);
  // Boolean flag so the p2pConnectionAtom effect can react to the options
  // null↔object transition without referencing the mutable options object.
  const hasP2pTarget = Boolean(options);

  const agentUrl = options?.agentUrl;
  const connectionToken = options?.connectionToken;
  const onError = options?.onError;
  const maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const reconnectBaseDelay = options?.reconnectBaseDelay ?? DEFAULT_BASE_DELAY;

  // Retry policy is read from refs so a change (e.g. last-candidate backoff bump)
  // does not re-run the connect effect, close the socket, and wipe message
  // handlers that ConnectionManager registered on the live connection object.
  const maxReconnectAttemptsRef = useRef(maxReconnectAttempts);
  maxReconnectAttemptsRef.current = maxReconnectAttempts;
  const reconnectBaseDelayRef = useRef(reconnectBaseDelay);
  reconnectBaseDelayRef.current = reconnectBaseDelay;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // The useState initializer above only runs on the hook's FIRST render. In the
  // real flow this hook is first rendered with null options (the address plan
  // resolves asynchronously in useAddressPlan, so activeUrl is null on render
  // 1) → state initialises to 'disconnected'. When agentUrl arrives on a later
  // render, React keeps that stale 'disconnected'. Child components (e.g.
  // FileBrowser) mount that same render and their effects run BEFORE this
  // hook's connect effect, so a waitForConnection() issued then would read the
  // stale 'disconnected' and reject "Connection lost" before the socket even
  // starts.
  //
  // Fix: promote to 'connecting' DURING RENDER on the null→url (and url→url
  // rotation) transition — React's supported "adjust state when a prop changes"
  // pattern. React re-renders this component synchronously before committing,
  // so the ref below ends at 'connecting' and children only ever mount with
  // 'connecting' — they correctly wait. An effect would be too late (child
  // effects run first). The prev-url guard ensures a genuine terminal
  // 'disconnected' (max reconnects hit, same url) is NOT flipped back —
  // agentUrl hasn't changed, so the guard won't match.
  useTransportReset(agentUrl, connectionToken, connectionState, setConnectionState);

  // Mirror connectionState into a ref so waitForConnection can read live state
  // without being re-created (and without stale closures) on every transition.
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  connectionStateRef.current = connectionState;

  // Mirror reconnectAttempt into a ref too, so the returned object can expose it
  // via a getter (see the useMemo below) without changing object identity.
  const reconnectAttemptStateRef = useRef<number>(reconnectAttempt);
  reconnectAttemptStateRef.current = reconnectAttempt;

  // Pending waitForConnection() waiters, settled event-driven from the
  // connectionState effect below (no busy-polling — works under fake timers).
  const waitersRef = useRef<Set<{ resolve: () => void; reject: (e: Error) => void }>>(new Set());

  useAgentWebSocket({
    agentUrl, connectionToken, connectionState,
    setConnectionState, setP2pState, setReconnectAttempt,
    generationRef, reconnectAttemptRef, handlersRef,
    maxReconnectAttemptsRef, reconnectBaseDelayRef, onErrorRef,
    reconnectTimerRef, wsRef, waitersRef,
  });

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    try { if (wsRef.current?.readyState === WebSocket.OPEN) {wsRef.current.send(JSON.stringify(msg));} }
    catch { /* connection will clean up on close */ }
  }, []);

  const onMessage = useCallback((handler: MessageHandler): (() => void) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  const close = useCallback(() => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
    setConnectionState('disconnected');
    setP2pState('disconnected');
  }, [setP2pState]);

  const waitForConnection = useCallback((timeoutMs = 15_000): Promise<void> => {
    const state = connectionStateRef.current;
    if (state === 'connected') {return Promise.resolve();}
    if (state === 'disconnected') {return Promise.reject(new Error('Connection lost'));}

    // 'connecting' | 'reconnecting' — register a waiter settled by the
    // connectionState effect. Guard with a timeout so a socket that never
    // opens doesn't hang the caller forever.
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        waitersRef.current.delete(waiter);
        reject(new Error('Connection timeout'));
      }, timeoutMs);
      waitersRef.current.add(waiter);
    });
  }, []);

  // Build a connection object whose identity is STABLE across state transitions
  // but CHANGES on every route switch (p2pEpoch bump). `sendMessage`/
  // `onMessage`/`close`/`waitForConnection` are useCallback-stable;
  // `connectionState` and `reconnectAttempt` are getters backed by refs, so the
  // object does NOT change on every render — an unrelated re-render (e.g.
  // toggling the bottom-bar tab) must not tear down the terminal. `p2pEpoch`
  // IS in the dependency list on purpose: switchAddressAtom bumps it so a fresh
  // object is produced and the p2pConnectionAtom effect re-runs, rebuilding
  // Terminal.tsx's xterm view against the new socket — even when the resolved
  // activeUrl does not change. Without this, switchAddressAtom's
  // `set(p2pConnectionAtom, null)` is never undone and the terminal stays
  // blank after a route switch. Consumers that need reactivity read the
  // primitive getter value into an effect dependency, which still updates
  // because the owning component re-renders on setState.
  const connection = useMemo<P2PConnection>(() => {
    // Referenced (not read) so the object identity changes with p2pEpoch — the
    // epoch is a pure "route switched" signal; the actual socket is tracked
    // inside wsRef by connectWs. See the comment above.
    void p2pEpoch;
    return {
      sendMessage,
      onMessage,
      close,
      waitForConnection,
      get connectionState() { return connectionStateRef.current; },
      get reconnectAttempt() { return reconnectAttemptStateRef.current; },
    };
  }, [sendMessage, onMessage, close, waitForConnection, p2pEpoch]);

  // Expose the stable connection object to the global atom so consumers
  // (Terminal, TerminalView) can subscribe without prop drilling. The
  // hasP2pTarget boolean flips when options goes null↔object, so the atom is
  // cleared on unmount and when switching to relay mode.
  // Publish synchronously before child mount effects so xterm's ConnectionManager
  // and the attach state machine read the same live socket on the first frame.
  useLayoutEffect(() => {
    if (hasP2pTarget) {
      setP2pConnection(connection);
    }
    return () => {
      setP2pConnection(null);
      setP2pState('disconnected');
    };
  }, [connection, hasP2pTarget, setP2pConnection, setP2pState]);

  useEffect(() => {
    if (!hasP2pTarget) {
      handlersRef.current.clear();
    }
  }, [hasP2pTarget]);

  if (!options) {return null;}
  return connection;
}
