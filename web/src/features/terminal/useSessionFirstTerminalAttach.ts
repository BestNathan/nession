import { useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { SessionRuntime } from '@/runtime/SessionRuntime';
import { forcedRelayAtom } from '@/atoms/session';
import {
  terminalSessionStateAtom,
  type TerminalStatus,
} from '@/terminal/state';

export { P2P_MAX_RECONNECT, ATTACH_TIMEOUT_MS } from '@/runtime/AttachStateMachine';

export interface UseSessionFirstTerminalAttachOptions {
  sessionId: string;
  runtime?: SessionRuntime | null;
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
}): void {
  const { sessionId, runtime, terminalState, setTerminalState, setReconnectCount } = opts;
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      const snapshot = runtime.getMirrorSnapshot();
      if (snapshot.phase !== 'idle') {
        setTerminalState(snapshot.phase);
        return;
      }
      runtime.attachController.reset();
      runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
      setReconnectCount(0);
      return;
    }
    const snapshot = runtime.getMirrorSnapshot();
    setTerminalState(snapshot.phase);
  }, [sessionId, runtime, setTerminalState, setReconnectCount]);

  useEffect(() => {
    if (sessionId && terminalState === 'idle' && runtime) {
      const result = runtime.attachController.dispatch({ type: 'SESSION_SELECTED' });
      setTerminalState(result.phase);
    }
  }, [sessionId, terminalState, setTerminalState, runtime]);
}

/**
 * Session-first attach mirror. SessionRuntime owns all attach protocol
 * (client.attach retry, relay begin/fallback); this hook only mirrors
 * controller outcomes and attach-phase snapshots into Jotai.
 */
export function useSessionFirstTerminalAttach({
  sessionId,
  runtime,
}: UseSessionFirstTerminalAttachOptions) {
  const [terminalState, setTerminalState] = useAtom(terminalSessionStateAtom);
  const setForcedRelay = useSetAtom(forcedRelayAtom);

  const [reconnectCount, setReconnectCount] = useState(0);

  useAttachOutcomeMirror(runtime, setTerminalState, setForcedRelay, setReconnectCount);
  useAttachSessionLifecycle({
    sessionId, runtime, terminalState, setTerminalState, setReconnectCount,
  });

  return { terminalState, reconnectCount };
}

export function isTerminalLive(state: TerminalStatus): boolean {
  return state === 'attached';
}
