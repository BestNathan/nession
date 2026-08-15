import { useEffect, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import type { WebSocketService } from '../../services/websocket';
import { sessionIdAtom, sessionNameAtom } from '../../atoms/session';
import { effectiveModeAtom, p2pConnectionAtom } from '../../atoms/connection';
import { terminalSessionStateAtom, lastResizeAtom } from '../state';

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
export function useTerminalStateMachine(options: UseTerminalStateMachineOptions = {}) {
  const { serverConnection } = options;
  const [sessionId] = useAtom(sessionIdAtom);
  const [sessionName] = useAtom(sessionNameAtom);
  const [mode] = useAtom(effectiveModeAtom);
  const [p2pConnection] = useAtom(p2pConnectionAtom);
  const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
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

  // ── Terminal session state machine ─────────────────────────────
  // Drives every protocol decision for the session: client.attach timing,
  // relay beginRelay, reconnect banners, and the attach timeout.
  useEffect(() => {
    switch (terminalState) {
      case 'idle':
        break;

      case 'connecting':
        // Socket is being created (p2p) or the server ws is authenticating
        // (relay).  Clear any stale state from a previous session.
        reconnectCountRef.current = 0;
        setReconnectCount(0);
        if (mode === 'relay' && serverConnection?.isConnected()) {
          // The server ws is already authenticated — onConnectionChange only
          // fires on status CHANGE, so this covers the case where the ws came
          // up before Terminal mounted.
          setTerminalState('connected');
        }
        break;

      case 'connected': {
        if (mode === 'relay') {
          // Relay: beginRelay is fire-and-forget — once sent, the agent pushes
          // terminal.output through the server.  Session size comes from
          // lastResizeAtom (written by the ResizeObserver in the view effect).
          const w = lastResizeRef.current?.cols;
          const h = lastResizeRef.current?.rows;
          serverConnection?.beginRelay(sessionId, undefined, w, h);
          setTerminalState('attached');
          break;
        }

        // P2P: send client.attach and wait for the agent's ok before entering
        // 'attached'.  Input typed before the ok is buffered by the transport
        // until the session is attached.
        const conn = p2pConnection!;
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

        // Watch for the attach ok / error response.
        const unsub = conn.onMessage((msg) => {
          if (msg.id !== attachId) { return; }
          if (msg.msg_type === 'ok') {
            setTerminalState('attached');
          } else if (msg.msg_type === 'error') {
            setTerminalState('failed');
          }
        });

        // If the agent never acks, back off into reconnecting.
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
        // Terminal I/O is live.  Clear the reconnect counter and banner.
        reconnectCountRef.current = 0;
        setReconnectCount(0);
        break;

      case 'reconnecting': {
        const count = reconnectCountRef.current + 1;
        reconnectCountRef.current = count;
        setReconnectCount(count);
        if (count > P2P_MAX_RECONNECT) {
          setTerminalState('failed');
          break;
        }
        // The socket reconnects via useP2PConnection → p2pState → 'connected'
        // → this effect re-runs and re-attaches.
        break;
      }

      case 'failed':
        break;
    }
  }, [mode, terminalState, sessionName, sessionId, serverConnection, p2pConnection, setTerminalState, setReconnectCount]);

  // Feed P2P transport transitions into the state machine.  connectionState is
  // a getter (no re-render on change), but this hook's owner re-renders on
  // every P2P state transition via useP2PConnection's internal state — so
  // reading it here in an effect keyed on the value tracks it correctly.
  // Relay mode is driven by the state machine directly (serverConnection auth
  // events), not this bridge.
  const p2pState = p2pConnection?.connectionState;
  useEffect(() => {
    if (mode !== 'p2p') { return; }
    if (p2pState === 'connected' && (terminalState === 'connecting' || terminalState === 'reconnecting')) {
      console.log('[Bridge] transitioning to connected');
      setTerminalState('connected');
    } else if ((p2pState === 'reconnecting' || p2pState === 'disconnected') &&
               (terminalState === 'attached' || terminalState === 'connected')) {
      setTerminalState('reconnecting');
    }
  }, [mode, p2pState, terminalState, setTerminalState]);

  return { terminalState, reconnectCount };
}
