import { useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { TerminalAgentApi } from '@/product/terminal/agent';
import {
  terminalControlAtomFamily,
  type TerminalControlState,
} from '@/product/terminal/state/terminalControl';

/** Mirror P2P agent control lease into Jotai (#1095). */
export function useTerminalControlBridge(
  sessionName: string,
  agentTerminalApi: TerminalAgentApi | null,
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
