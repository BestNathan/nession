import { useEffect, useRef, useState, type MutableRefObject, type SetStateAction } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { P2PConnection } from '@/hooks/useP2PConnection';
import type { WebSocketService } from '@/services/websocket';
import { manualOverrideAtom, forcedRelayAtom } from '@/atoms/session';
import { effectiveModeAtom, p2pEpochAtom } from '@/atoms/connection';
import {
  terminalSessionStateAtom,
  lastResizeAtom,
  terminalTransportReadyAtom,
  type TerminalStatus,
} from '@/terminal/state';

let _msgCounter = 0;
function generateId(): string {
  return `web-${Date.now()}-${++_msgCounter}`;
}

export const P2P_MAX_RECONNECT = 10;
export const ATTACH_TIMEOUT_MS = 10_000;

export interface UseSessionFirstTerminalAttachOptions {
  sessionId: string;
  sessionName: string;
  p2pConnection: P2PConnection | null;
  wsService: WebSocketService;
}

function useWsConnected(wsService: WebSocketService): boolean {
  const [wsConnected, setWsConnected] = useState(() => wsService.isConnected());
  useEffect(() => {
    setWsConnected(wsService.isConnected());
    return wsService.onConnectionChange((status) => {
      setWsConnected(status === 'authenticated');
    });
  }, [wsService]);
  return wsConnected;
}

function useP2pDisconnectPromote(
  effectiveMode: 'p2p' | 'relay',
  p2pState: string | undefined,
  terminalState: TerminalStatus,
  setTerminalState: (s: TerminalStatus) => void,
): void {
  useEffect(() => {
    if (effectiveMode !== 'p2p') { return; }
    if (
      (p2pState === 'disconnected' || p2pState === 'reconnecting')
      && terminalState === 'attached'
    ) {
      setTerminalState('reconnecting');
    }
  }, [effectiveMode, p2pState, terminalState, setTerminalState]);
}

function useRelayFailedRecovery(
  effectiveMode: 'p2p' | 'relay',
  terminalState: TerminalStatus,
  wsConnected: boolean,
  setTerminalState: (s: TerminalStatus) => void,
): void {
  useEffect(() => {
    if (effectiveMode === 'relay' && terminalState === 'failed' && wsConnected) {
      setTerminalState('connecting');
    }
  }, [effectiveMode, terminalState, wsConnected, setTerminalState]);
}

interface P2pAttachCtx {
  sessionName: string;
  p2pConnection: P2PConnection;
  terminalState: TerminalStatus;
  manualOverride: string | null;
  lastResize: { cols: number; rows: number } | null;
  attachGenerationRef: MutableRefObject<number>;
  attachTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  reconnectCountRef: MutableRefObject<number>;
  setReconnectCount: (n: number) => void;
  setTerminalState: (value: SetStateAction<TerminalStatus>) => void;
  setForcedRelay: (v: boolean) => void;
  setP2pEpoch: (update: (epoch: number) => number) => void;
}

function runP2pAttach(ctx: P2pAttachCtx): (() => void) | undefined {
  const gen = ++ctx.attachGenerationRef.current;
  const attachId = generateId();

  ctx.p2pConnection.sendMessage({
    msg_type: 'client.attach',
    id: attachId,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      session_name: ctx.sessionName,
      ...(ctx.lastResize ? { width: ctx.lastResize.cols, height: ctx.lastResize.rows } : {}),
    },
  });

  const unsub = ctx.p2pConnection.onMessage((msg) => {
    if (gen !== ctx.attachGenerationRef.current || msg.id !== attachId) { return; }
    if (msg.msg_type === 'ok') {
      ctx.reconnectCountRef.current = 0;
      ctx.setReconnectCount(0);
      ctx.setTerminalState('attached');
    } else if (msg.msg_type === 'error') {
      if (ctx.manualOverride) {
        ctx.setTerminalState('failed');
      } else {
        ctx.setP2pEpoch((epoch) => epoch + 1);
        ctx.setForcedRelay(true);
        ctx.setTerminalState('connecting');
      }
    }
  });

  ctx.attachTimerRef.current = setTimeout(() => {
    ctx.attachTimerRef.current = null;
    if (gen !== ctx.attachGenerationRef.current) { return; }
    unsub();
    const count = ctx.reconnectCountRef.current + 1;
    ctx.reconnectCountRef.current = count;
    ctx.setReconnectCount(count);
    if (count > P2P_MAX_RECONNECT) {
      if (ctx.manualOverride) {
        ctx.setTerminalState('failed');
      } else {
        ctx.setP2pEpoch((epoch) => epoch + 1);
        ctx.setForcedRelay(true);
        ctx.setTerminalState('connecting');
      }
      return;
    }
    // Toggle state so a timeout while already reconnecting still re-triggers attach.
    ctx.setTerminalState((prev) => (prev === 'connecting' ? 'reconnecting' : 'connecting'));
  }, ATTACH_TIMEOUT_MS);

  return () => {
    unsub();
    if (ctx.attachTimerRef.current) {
      clearTimeout(ctx.attachTimerRef.current);
      ctx.attachTimerRef.current = null;
    }
  };
}

/**
 * Session-first attach driver — transport-first protocol.
 *
 * Invariant: client.attach / beginRelay run ONLY after terminalTransportReadyAtom
 * is true (xterm mounted + ConnectionManager.onOutput wired). Replaces the shared
 * state machine for session-first, eliminating the race where scrollback arrives
 * before output handlers exist.
 */
export function useSessionFirstTerminalAttach({
  sessionId,
  sessionName,
  p2pConnection,
  wsService,
}: UseSessionFirstTerminalAttachOptions) {
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [transportReady] = useAtom(terminalTransportReadyAtom);
  const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
  const [lastResize] = useAtom(lastResizeAtom);
  const setForcedRelay = useSetAtom(forcedRelayAtom);
  const setP2pEpoch = useSetAtom(p2pEpochAtom);

  const reconnectCountRef = useRef(0);
  const [reconnectCount, setReconnectCount] = useState(0);
  const attachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachGenerationRef = useRef(0);
  /** Set when transport tears down while attached — triggers client.attach resend. */
  const needsTransportReattachRef = useRef(false);

  const wsConnected = useWsConnected(wsService);
  const p2pState = p2pConnection?.connectionState;

  useP2pDisconnectPromote(effectiveMode, p2pState, terminalState, setTerminalState);
  useRelayFailedRecovery(effectiveMode, terminalState, wsConnected, setTerminalState);

  useEffect(() => {
    reconnectCountRef.current = 0;
    setReconnectCount(0);
    needsTransportReattachRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (sessionId && terminalState === 'idle') {
      setTerminalState('connecting');
    }
  }, [sessionId, terminalState, setTerminalState]);

  useEffect(() => {
    if (!transportReady) {
      if (terminalState === 'attached') {
        needsTransportReattachRef.current = true;
      }
      return;
    }

    if (!sessionId) { return; }

    const transportReattach = needsTransportReattachRef.current;
    if (transportReattach) {
      needsTransportReattachRef.current = false;
    }

    const canAttach =
      terminalState === 'connecting'
      || terminalState === 'reconnecting'
      || transportReattach
      || (terminalState === 'failed' && effectiveMode === 'relay');

    if (effectiveMode === 'relay') {
      if (!wsConnected || !canAttach) { return; }
      if (terminalState === 'attached' && !transportReattach) { return; }

      wsService.beginRelay(sessionId, undefined, lastResize?.cols, lastResize?.rows);
      setTerminalState('attached');
      reconnectCountRef.current = 0;
      setReconnectCount(0);
      return;
    }

    if (!p2pConnection || p2pState !== 'connected' || !canAttach) { return; }

    return runP2pAttach({
      sessionName,
      p2pConnection,
      terminalState,
      manualOverride,
      lastResize,
      attachGenerationRef,
      attachTimerRef,
      reconnectCountRef,
      setReconnectCount,
      setTerminalState,
      setForcedRelay,
      setP2pEpoch,
    });
  }, [
    transportReady,
    sessionId,
    sessionName,
    effectiveMode,
    wsConnected,
    wsService,
    p2pConnection,
    p2pState,
    terminalState,
    manualOverride,
    lastResize,
    setTerminalState,
    setForcedRelay,
    setP2pEpoch,
  ]);

  return { terminalState, reconnectCount };
}

export function isTerminalLive(state: TerminalStatus): boolean {
  return state === 'attached';
}
