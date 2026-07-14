import { useEffect, useRef, useCallback, useState, useMemo } from 'react';

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
  activeRef: React.MutableRefObject<boolean>;
  reconnectAttemptRef: React.MutableRefObject<number>;
  setConnectionState: (s: ConnectionState) => void;
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
  const wsUrl = buildWsUrl(ctx.agentUrl, ctx.connectionToken);
  console.log('[P2P] Connecting to:', wsUrl);

  const ws = new WebSocket(wsUrl);
  ctx.wsRef.current = ws;
  ws.binaryType = 'arraybuffer';

  if (ctx.reconnectAttemptRef.current === 0) {
    ctx.setConnectionState('connecting');
  }

  ws.onopen = () => {
    if (!ctx.activeRef.current) { ws.close(); return; }
    console.log('[P2P] Connected');
    ctx.reconnectAttemptRef.current = 0;
    ctx.setReconnectAttempt(0);
    ctx.setConnectionState('connected');
  };

  ws.onmessage = (event) => {
    if (!ctx.activeRef.current) {return;}
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
    if (ctx.activeRef.current && ctx.reconnectAttemptRef.current === 0) {
      ctx.onError?.(new Error('P2P WebSocket connection error'));
    }
  };

  ws.onclose = () => {
    console.log('[P2P] WebSocket closed');
    if (!ctx.activeRef.current) {return;}
    const attempt = ctx.reconnectAttemptRef.current;
    if (attempt >= ctx.maxReconnectAttempts) {
      console.log('[P2P] Max reconnect attempts reached');
      ctx.setConnectionState('disconnected');
      return;
    }
    ctx.setConnectionState('reconnecting');
    ctx.setReconnectAttempt(attempt + 1);
    ctx.reconnectAttemptRef.current = attempt + 1;

    const delay = Math.min(ctx.reconnectBaseDelay * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
    console.log(`[P2P] Scheduling reconnect in ${delay}ms (attempt ${attempt + 1}/${ctx.maxReconnectAttempts})`);

    ctx.reconnectTimerRef.current = setTimeout(() => {
      ctx.reconnectTimerRef.current = null;
      if (ctx.activeRef.current) {ctx.connectSelf();}
    }, delay);
  };
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
  const activeRef = useRef(true);
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

  const agentUrl = options?.agentUrl;
  const connectionToken = options?.connectionToken;
  const onError = options?.onError;
  const maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const reconnectBaseDelay = options?.reconnectBaseDelay ?? DEFAULT_BASE_DELAY;

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
  // effects run first). The prev-url guard means a genuine terminal
  // 'disconnected' (max reconnects hit, same url) is NOT flipped back.
  const prevAgentUrlRef = useRef<string | undefined>(undefined);
  if (
    agentUrl &&
    agentUrl !== prevAgentUrlRef.current &&
    connectionState === 'disconnected'
  ) {
    setConnectionState('connecting');
  }
  prevAgentUrlRef.current = agentUrl;

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

  useEffect(() => {
    if (!agentUrl) {return;}
    activeRef.current = true;

    const ctx: ConnectWsContext = {
      agentUrl, connectionToken, activeRef, reconnectAttemptRef,
      setConnectionState, setReconnectAttempt, handlersRef,
      maxReconnectAttempts, reconnectBaseDelay, onError,
      reconnectTimerRef, wsRef,
      connectSelf: () => connectWs(ctx),
    };
    connectWs(ctx);

    const handlers = handlersRef.current;
    return () => {
      activeRef.current = false;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
      handlers.clear();
      // NOTE: pending waitForConnection() waiters are intentionally NOT rejected
      // here. Under React StrictMode (dev) this effect runs mount → cleanup →
      // mount; rejecting on cleanup would fail a file op issued during the first
      // mount even though the second connection is about to succeed. Waiters
      // persist (ref survives the remount) and are settled by the connectionState
      // effect on (re)connect, or expire via their own timeout on real unmount.
    };
  }, [agentUrl, connectionToken, onError, maxReconnectAttempts, reconnectBaseDelay]);

  // Settle any pending waitForConnection() promises whenever the state settles
  // into a terminal-for-waiting value ('connected' → resolve, 'disconnected' →
  // reject). Event-driven so it works with fake timers and adds no latency.
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
  }, [connectionState]);

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
  }, []);

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

  // Build a STABLE connection object. `sendMessage`/`onMessage`/`close`/
  // `waitForConnection` are useCallback-stable; `connectionState` and
  // `reconnectAttempt` are exposed as getters backed by refs so the object
  // identity never changes across state transitions. This matters because
  // `Terminal.tsx` rebuilds its xterm view when the `p2pConnection` prop
  // identity changes — returning a fresh object literal every render (the old
  // behaviour) made unrelated re-renders (e.g. toggling the bottom-bar tab)
  // tear down and recreate the terminal. Consumers that need reactivity read
  // the primitive getter value into an effect dependency (e.g. useP2PWithFallback),
  // which still updates because the owning component re-renders on setState.
  const connection = useMemo<P2PConnection>(() => ({
    sendMessage,
    onMessage,
    close,
    waitForConnection,
    get connectionState() { return connectionStateRef.current; },
    get reconnectAttempt() { return reconnectAttemptStateRef.current; },
  }), [sendMessage, onMessage, close, waitForConnection]);

  if (!options) {return null;}
  return connection;
}
