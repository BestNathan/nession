import { getDefaultStore } from 'jotai';
import type { TerminalController, TerminalControllerEvents } from '../controller/TerminalController';
import { inputModeAtomFamily } from '../state/input';
import { lastResizeAtom } from '../state/terminal';
import { terminalTransportReadyAtom } from '../state/transport';

/**
 * Mirrors imperative TerminalController events into Jotai atoms for React UI.
 * Keeps terminal/** free of direct getDefaultStore() writes in the controller.
 */
export function createTerminalRuntimeAdapter(): TerminalControllerEvents {
  const store = getDefaultStore();
  return {
    onTransportReady: (ready) => {
      store.set(terminalTransportReadyAtom, ready);
    },
    onInputModeChange: (sid, mode) => {
      store.set(inputModeAtomFamily(sid), mode);
    },
    onResize: (_sid, cols, rows) => {
      store.set(lastResizeAtom, { cols, rows });
    },
  };
}

export function bindTerminalRuntimeAdapter(
  controller: TerminalController,
): () => void {
  controller.events = createTerminalRuntimeAdapter();
  return () => {
    controller.events = undefined;
    getDefaultStore().set(terminalTransportReadyAtom, false);
  };
}
