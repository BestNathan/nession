import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { P2PConnection } from '@/hooks/useP2PConnection';
import type { ConnectionState } from '@/services/socket/types';
import type { WebSocketService } from '@/services/websocket';
import type { SessionRuntime } from '@/runtime/SessionRuntime';
import { forcedRelayAtom, manualOverrideAtom } from '@/atoms/session';
import { effectiveModeAtom } from '@/atoms/connection';
import {
  terminalSessionStateAtom,
  lastResizeAtom,
  terminalTransportReadyAtom,
  type TerminalStatus,
} from '@/terminal/state';

export { P2P_MAX_RECONNECT, ATTACH_TIMEOUT_MS } from '@/runtime/AttachStateMachine';

export interface UseSessionFirstTerminalAttachOptions {
  sessionId: string;
  sessionName: string;
  p2pConnection: P2PConnection | null;
  p2pState: ConnectionState;
  wsService: WebSocketService;
  runtime?: SessionRuntime | null;
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

function useAttachOutcomeMirror(
  runtime: SessionRuntime | null | undefined,
  setTerminalState: (s: TerminalStatus) => void,
  setForcedRelay: (v: boolean) => void,
  setReconnectCount: (n: number) => void,
): void {
  useEffect(() => {
    if (!runtime) {
      return;
    }
    return runtime.attachController.subscribeOutcomes((result) => {
      setTerminalState(result.phase);
      setReconnectCount(result.reconnectCount);
      if (result.forceRelay) {
        setForcedRelay(true);
      }
    });
  }, [runtime, setTerminalState, setForcedRelay, setReconnectCount]);
}

function useAttachSessionLifecycle(opts: {
  sessionId: string;
  runtime: SessionRuntime | null | undefined;
  terminalState: TerminalStatus;
  setTerminalState: (s: TerminalStatus) => void;
  setReconnectCount: (n: number) => void;
  needsTransportReattachRef: MutableRefObject<boolean>;
}): void {
  const {
    sessionId, runtime, terminalState, setTerminalState, setReconnectCount, needsTransportReattachRef,
  } = opts;
  useEffect(() => {
    if (!runtime) {
      return;
    }
    runtime.attachController.reset();
    runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
    needsTransportReattachRef.current = false;
    setReconnectCount(0);
  }, [sessionId, runtime, setReconnectCount, needsTransportReattachRef]);

  useEffect(() => {
    if (sessionId && terminalState === 'idle' && runtime) {
      const result = runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
      setTerminalState(result.phase);
    }
  }, [sessionId, terminalState, setTerminalState, runtime]);
}

function useAttachDriverEffect(opts: {
  runtime: SessionRuntime | null | undefined;
  sessionId: string;
  sessionName: string;
  effectiveMode: 'p2p' | 'relay';
  transportReady: boolean;
  terminalState: TerminalStatus;
  wsConnected: boolean;
  wsService: WebSocketService;
  p2pConnection: P2PConnection | null;
  p2pState: ConnectionState;
  manualOverride: string | null;
  lastResize: { cols: number; rows: number } | null;
  setTerminalState: (s: TerminalStatus) => void;
  setReconnectCount: (n: number) => void;
  needsTransportReattachRef: MutableRefObject<boolean>;
}): void {
  const {
    runtime, sessionId, sessionName, effectiveMode, transportReady, terminalState,
    wsConnected, wsService, p2pConnection, p2pState, manualOverride, lastResize,
    setTerminalState, setReconnectCount, needsTransportReattachRef,
  } = opts;

  useEffect(() => {
    if (!runtime) {
      return;
    }

    if (!transportReady) {
      if (terminalState === 'attached') {
        needsTransportReattachRef.current = true;
        runtime.attachController.dispatch({ type: 'TRANSPORT_LOST' });
      }
      return;
    }

    runtime.attachController.dispatch({ type: 'TRANSPORT_READY' });
    if (!sessionId) {
      return;
    }

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
      if (!wsConnected || !canAttach || (terminalState === 'attached' && !transportReattach)) {
        return;
      }
      wsService.beginRelay(sessionId, undefined, lastResize?.cols, lastResize?.rows);
      const result = runtime.attachController.dispatch({ type: 'RELAY_BEGIN_OK' });
      setTerminalState(result.phase);
      setReconnectCount(result.reconnectCount);
      return;
    }

    if (
      !p2pConnection
      || p2pState !== 'connected'
      || !canAttach
      || !runtime.attachController.canStartAttach(transportReady, true, wsConnected, 'p2p')
    ) {
      return;
    }

    return runtime.attachController.startP2PAttach({
      sessionName,
      p2pConnection,
      manualRoute: manualOverride !== null,
      lastResize,
    });
  }, [
    runtime, transportReady, sessionId, sessionName, effectiveMode, wsConnected, wsService,
    p2pConnection, p2pState, terminalState, manualOverride, lastResize,
    setTerminalState, setReconnectCount, needsTransportReattachRef,
  ]);
}

function useP2pTransportLostPromote(opts: {
  effectiveMode: 'p2p' | 'relay';
  p2pState: ConnectionState;
  terminalState: TerminalStatus;
  runtime: SessionRuntime | null | undefined;
  setTerminalState: (s: TerminalStatus) => void;
}): void {
  const { effectiveMode, p2pState, terminalState, runtime, setTerminalState } = opts;
  useEffect(() => {
    if (effectiveMode !== 'p2p' || !runtime) {
      return;
    }
    if (
      (p2pState === 'disconnected' || p2pState === 'reconnecting')
      && terminalState === 'attached'
    ) {
      const result = runtime.attachController.dispatch({ type: 'TRANSPORT_LOST' });
      setTerminalState(result.phase);
    }
  }, [effectiveMode, p2pState, terminalState, setTerminalState, runtime]);
}

/**
 * Session-first attach adapter — mirrors SessionRuntime attach ownership into Jotai.
 */
export function useSessionFirstTerminalAttach({
  sessionId,
  sessionName,
  p2pConnection,
  p2pState,
  wsService,
  runtime,
}: UseSessionFirstTerminalAttachOptions) {
  const [effectiveMode] = useAtom(effectiveModeAtom);
  const [manualOverride] = useAtom(manualOverrideAtom);
  const [transportReady] = useAtom(terminalTransportReadyAtom);
  const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
  const [lastResize] = useAtom(lastResizeAtom);
  const setForcedRelay = useSetAtom(forcedRelayAtom);

  const [reconnectCount, setReconnectCount] = useState(0);
  const needsTransportReattachRef = useRef(false);
  const wsConnected = useWsConnected(wsService);

  useAttachOutcomeMirror(runtime, setTerminalState, setForcedRelay, setReconnectCount);
  useAttachSessionLifecycle({
    sessionId, runtime, terminalState, setTerminalState, setReconnectCount, needsTransportReattachRef,
  });

  useEffect(() => {
    if (effectiveMode === 'relay' && terminalState === 'failed' && wsConnected) {
      setTerminalState('connecting');
    }
  }, [effectiveMode, terminalState, wsConnected, setTerminalState]);

  useAttachDriverEffect({
    runtime, sessionId, sessionName, effectiveMode, transportReady, terminalState,
    wsConnected, wsService, p2pConnection, p2pState, manualOverride, lastResize,
    setTerminalState, setReconnectCount, needsTransportReattachRef,
  });
  useP2pTransportLostPromote({
    effectiveMode, p2pState, terminalState, runtime, setTerminalState,
  });

  return { terminalState, reconnectCount };
}

export function isTerminalLive(state: TerminalStatus): boolean {
  return state === 'attached';
}
