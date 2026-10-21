import { useCallback, useEffect } from 'react';
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
  takeControl: () => Promise<void>;
} {
  const setControl = useSetAtom(terminalControlAtomFamily(sessionName));
  const control = useAtomValue(terminalControlAtomFamily(sessionName));

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

  return { control, takeControl };
}
