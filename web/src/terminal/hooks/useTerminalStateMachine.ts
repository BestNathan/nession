import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { P2PConnection, P2PConnectionState as ConnectionState } from '@/services/socket/p2pTypes';
import type { WebSocketService } from '../../services/websocket';
import { sessionIdAtom, sessionNameAtom, manualOverrideAtom, forcedRelayAtom } from '../../atoms/session';
import { effectiveModeAtom, p2pConnectionAtom } from '../../atoms/connection';
import { terminalSessionStateAtom, lastResizeAtom, terminalTransportReadyAtom, type TerminalStatus } from '../state';

let _msgCounter = 0;
function generateId(): string {
  return `web-${Date.now()}-${++_msgCounter}`;
}

/** Max reconnect entries before the session is declared failed. */
export const P2P_MAX_RECONNECT = 10;
/** How long to wait for client.attach ok before backing off into reconnecting. */
export const ATTACH_TIMEOUT_MS = 10_000;

export interface UseTerminalStateMachineOptions {
  /** Server WebSocket transport, required for relay-mode beginRelay. */
  serverConnection?: WebSocketService;
  /** Live socket from useP2PAttachTransport — avoids p2pConnectionAtom publish lag. */
  p2pConnection?: P2PConnection | null;
  /** Reactive connection state from useP2PAttachTransport — do not read from p2pConnection getter. */
  p2pState?: ConnectionState;
}

function useP2PAttachBridge(opts: {
  mode: 'p2p' | 'relay';
  transportReady: boolean;
  p2pState: ConnectionState | undefined;
  terminalState: TerminalStatus;
  setTerminalState: (update: TerminalStatus | ((prev: TerminalStatus) => TerminalStatus)) => void;
}): void {
  const { mode, transportReady, p2pState, terminalState, setTerminalState } = opts;
  const prevTransportReadyRef = useRef(false);

  useEffect(() => {
    if (mode !== 'p2p' || !transportReady) { return; }
    if (p2pState === 'connected' && (terminalState === 'connecting' || terminalState === 'reconnecting')) {
      console.log('[Bridge] transitioning to connected');
      setTerminalState('connected');
    } else if ((p2pState === 'reconnecting' || p2pState === 'disconnected') &&
               (terminalState === 'attached' || terminalState === 'connected')) {
      setTerminalState('reconnecting');
    }
  }, [mode, transportReady, p2pState, terminalState, setTerminalState]);

  useEffect(() => {
    const prev = prevTransportReadyRef.current;
    prevTransportReadyRef.current = transportReady;
    if (mode !== 'p2p' || !transportReady || prev || p2pState !== 'connected') {
      return;
    }
    if (terminalState === 'attached' || terminalState === 'connected') {
      setTerminalState('connected');
    }
  }, [mode, transportReady, p2pState, terminalState, setTerminalState]);
}

/**
 * Terminal session state machine — drives every protocol decision for the
 * session: client.attach timing, relay beginRelay, reconnect banners, and the
 * attach timeout. Extracted from the old Terminal.tsx effect so the protocol
 * logic is reusable without a live xterm view.
 *
 * Reads sessionId, sessionName, mode, p2pConnection, terminalSessionStateAtom,
 * and lastResizeAtom from jotai. Returns the live terminalState (atom) plus the
 * reactive reconnectCount so consumers can drive banner rendering / input
 * buffering without touching the protocol code (the old effect called
 * view.setExternalBanner / view.connection.flushInputBuffer directly).
 */
function useTransportReattachOnViewportRewire(opts: {
  transportReady: boolean;
  terminalState: TerminalStatus;
  setTerminalState: (update: TerminalStatus | ((prev: TerminalStatus) => TerminalStatus)) => void;
}): void {
  const { transportReady, terminalState, setTerminalState } = opts;
  const needsTransportReattachRef = useRef(false);
  const prevTransportReadyRef = useRef(false);

  useEffect(() => {
    const prev = prevTransportReadyRef.current;
    prevTransportReadyRef.current = transportReady;

    if (!transportReady) {
      if (terminalState === 'attached') {
        needsTransportReattachRef.current = true;
      }
      return;
    }

    if (transportReady && !prev && needsTransportReattachRef.current) {
      needsTransportReattachRef.current = false;
      if (terminalState === 'attached') {
        setTerminalState('connected');
      }
    }
  }, [transportReady, terminalState, setTerminalState]);
}

function useTerminalAttachProtocolEffect(opts: {
  mode: 'p2p' | 'relay';
  terminalState: TerminalStatus;
  sessionName: string;
  sessionId: string;
  serverConnection: WebSocketService | undefined;
  p2pConnection: P2PConnection | null;
  manualOverride: string | null;
  transportReady: boolean;
  lastResizeRef: MutableRefObject<{ cols: number; rows: number } | null>;
  reconnectCountRef: MutableRefObject<number>;
  attachTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setTerminalState: (update: TerminalStatus | ((prev: TerminalStatus) => TerminalStatus)) => void;
  setReconnectCount: (n: number) => void;
  setForcedRelay: (update: boolean | ((prev: boolean) => boolean)) => void;
}): void {
  const {
    mode, terminalState, sessionName, sessionId, serverConnection, p2pConnection,
    manualOverride, transportReady, lastResizeRef, reconnectCountRef, attachTimerRef,
    setTerminalState, setReconnectCount, setForcedRelay,
  } = opts;

  useEffect(() => {
    switch (terminalState) {
      case 'idle':
        break;

      case 'connecting':
        reconnectCountRef.current = 0;
        setReconnectCount(0);
        // isAuthenticated, not isConnected: a ws that is open but not yet
        // authenticated must not fire beginRelay — the server would drop it and
        // nothing would re-begin until the next loss cycle.
        if (mode === 'relay' && transportReady && serverConnection?.isAuthenticated()) {
          setTerminalState('connected');
        }
        break;

      case 'connected': {
        if (mode === 'relay') {
          if (!transportReady) { break; }
          const w = lastResizeRef.current?.cols;
          const h = lastResizeRef.current?.rows;
          serverConnection?.beginRelay(sessionId, undefined, w, h);
          setTerminalState('attached');
          break;
        }

        if (!p2pConnection) { break; }
        const conn = p2pConnection;
        const w = lastResizeRef.current?.cols;
        const h = lastResizeRef.current?.rows;
        const attachId = generateId();

        conn.sendMessage({
          msg_type: 'client.attach',
          id: attachId,
          timestamp: Math.floor(Date.now() / 1000),
          payload: {
            session_name: sessionName,
            ...(w !== undefined && h !== undefined ? { width: w, height: h } : {}),
          },
        });

        const unsub = conn.onMessage((msg) => {
          if (msg.id !== attachId) { return; }
          if (msg.msg_type === 'ok') {
            setTerminalState('attached');
          } else if (msg.msg_type === 'error') {
            if (manualOverride) {
              setTerminalState('failed');
            } else {
              // Auto-mode attach error falls back to relay. forcedRelay is the
              // only signal needed: mode flips effectiveModeAtom to relay and
              // the machine re-runs its relay branch. The route epoch stays a
              // user-route identity (#593 SC8 — no p2pEpoch protocol reset).
              setForcedRelay(true);
            }
          }
        });

        attachTimerRef.current = setTimeout(() => {
          attachTimerRef.current = null;
          unsub();
          setTerminalState('reconnecting');
        }, ATTACH_TIMEOUT_MS);

        return () => {
          unsub();
          if (attachTimerRef.current) {
            clearTimeout(attachTimerRef.current);
            attachTimerRef.current = null;
          }
        };
      }

      case 'attached':
        reconnectCountRef.current = 0;
        setReconnectCount(0);
        break;

      case 'reconnecting': {
        if (mode === 'relay') {
          setTerminalState('connecting');
          break;
        }
        const count = reconnectCountRef.current + 1;
        reconnectCountRef.current = count;
        setReconnectCount(count);
        if (count > P2P_MAX_RECONNECT) {
          if (manualOverride) {
            setTerminalState('failed');
          } else {
            // Budget exhausted in auto mode — relay fallback (see attach-error
            // branch): forcedRelay alone signals the transport flip.
            setForcedRelay(true);
          }
          break;
        }
        break;
      }

      case 'failed':
        if (mode === 'relay') {
          setTerminalState('connecting');
        }
        break;
    }
  }, [
    mode, terminalState, sessionName, sessionId, serverConnection, p2pConnection,
    manualOverride, setForcedRelay, setTerminalState, setReconnectCount,
    transportReady, lastResizeRef, reconnectCountRef, attachTimerRef,
  ]);
}

export function useTerminalStateMachine(options: UseTerminalStateMachineOptions = {}) {
  const { serverConnection, p2pConnection: p2pConnectionOverride } = options;
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [mode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [p2pConnectionFromAtom] = useAtom(p2pConnectionAtom);
  const p2pConnection = p2pConnectionOverride ?? p2pConnectionFromAtom;
  const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
  const [transportReady] = useAtom(terminalTransportReadyAtom);
  const setForcedRelay = useSetAtom(forcedRelayAtom);
  const [lastResize] = useAtom(lastResizeAtom);
  // Read via ref so ResizeObserver updates don't re-trigger the state machine
  // effect (which would cancel the attach timeout and restart the cycle).
  const lastResizeRef = useRef(lastResize);
  lastResizeRef.current = lastResize;

  // Reconnect counter tracked via ref so incrementing it in the 'reconnecting'
  // case doesn't re-trigger the state machine effect (a state dep would loop
  // the effect through the reconnect budget). Mirrored into React state so
  // consumers can render the attempt count reactively.
  const reconnectCountRef = useRef(0);
  const [reconnectCount, setReconnectCount] = useState(0);
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useTransportReattachOnViewportRewire({ transportReady, terminalState, setTerminalState });

  useTerminalAttachProtocolEffect({
    mode, terminalState, sessionName, sessionId, serverConnection, p2pConnection,
    manualOverride, transportReady, lastResizeRef, reconnectCountRef, attachTimerRef,
    setTerminalState, setReconnectCount, setForcedRelay,
  });

  const p2pState = options.p2pState ?? p2pConnection?.connectionState;
  useP2PAttachBridge({ mode, transportReady, p2pState, terminalState, setTerminalState });

  return { terminalState, reconnectCount };
}
