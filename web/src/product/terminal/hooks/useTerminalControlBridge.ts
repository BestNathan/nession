import { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  terminalControlAtomFamily,
  type TerminalControlState,
} from '@/product/terminal/state/terminalControl';

/**
 * The control surface for the active route (#2157): the direct Agent API on
 * P2P, the Server relay plugin on Relay. Both carry the same lease level.
 */
export interface TerminalControlSource {
  getControlState(sessionName: string): TerminalControlState;
  onControlChanged(cb: (sessionName: string, state: TerminalControlState) => void): () => void;
  acquireControl(sessionName: string): Promise<
    { ok: true; generation: number } | { ok: false; error: string }
  >;
}

/** Mirror the active route's control lease into Jotai (#1095). */
export function useTerminalControlBridge(
  sessionName: string,
  agentTerminalApi: TerminalControlSource | null,
): {
  control: TerminalControlState;
  /** Explicit fallback: the observer bar's Take control. */
  takeControl: () => Promise<void>;
  /**
   * Automatic takeover on meaningful foreground activation (#2286).
   *
   * Resolves `true` only when the call **changed** who owns the session — a
   * client that already holds the lease (or already knows it does) is a no-op,
   * because restating the lease is not a reason to move the shared pane.
   */
  adoptControl: () => Promise<boolean>;
} {
  const setControl = useSetAtom(terminalControlAtomFamily(sessionName));
  const control = useAtomValue(terminalControlAtomFamily(sessionName));
  // Event handlers and async continuations read the current lease through this
  // ref: the callback is built once per session/source, and a stale closure
  // would either skip a takeover or restate a lease it no longer holds.
  const controlRef = useRef(control);
  controlRef.current = control;

  useEffect(() => {
    if (!agentTerminalApi || !sessionName) {
      return;
    }
    setControl({ ...agentTerminalApi.getControlState(sessionName), sessionName });
    return agentTerminalApi.onControlChanged((name, state) => {
      if (name === sessionName) {
        setControl({ ...state, sessionName });
      }
    });
  }, [agentTerminalApi, sessionName, setControl]);

  const takeControl = useCallback(async () => {
    if (!agentTerminalApi || !sessionName) {
      return;
    }
    const result = await agentTerminalApi.acquireControl(sessionName);
    if (result.ok) {
      setControl({
        role: 'controller',
        generation: result.generation,
        controllerClientId: undefined,
        sessionName,
      });
    }
  }, [agentTerminalApi, sessionName, setControl]);

  const adoptControl = useCallback(async (): Promise<boolean> => {
    if (!agentTerminalApi || !sessionName) {
      return false;
    }
    const before = controlRef.current;
    // A holder that already knows its generation has nothing to acquire. The
    // check is deliberately on *both* facts: the atom defaults to `controller`
    // before any lease has been stated, and a client that merely assumes it
    // owns the session must still ask.
    if (before.role === 'controller' && before.generation !== undefined) {
      return false;
    }
    const result = await agentTerminalApi.acquireControl(sessionName);
    if (!result.ok) {
      return false;
    }
    setControl({
      role: 'controller',
      generation: result.generation,
      controllerClientId: undefined,
      sessionName,
    });
    // The Agent makes a holder's re-acquire idempotent, so an unchanged
    // generation means this client already owned the session and only lacked
    // the generation locally: no handoff happened, and there is no reason to
    // restate the size.
    return before.role !== 'controller' || before.generation !== result.generation;
  }, [agentTerminalApi, sessionName, setControl]);

  return { control, takeControl, adoptControl };
}
