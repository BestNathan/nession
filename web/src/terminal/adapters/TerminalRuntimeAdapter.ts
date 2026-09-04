import { getDefaultStore } from 'jotai';
import type { TerminalControllerEvents } from '../controller/TerminalController';
import { inputModeAtomFamily } from '../state/input';
import { lastResizeAtom } from '../state/terminal';
import { terminalTransportReadyAtom } from '../state/transport';
import type { SessionRuntime } from '@/runtime/SessionRuntime';

/**
 * Mirrors imperative TerminalController events into Jotai atoms for React UI.
 * Keeps terminal/** free of direct getDefaultStore() writes in the controller.
 *
 * Injected into the TerminalController at construction (useTerminal), so
 * readiness published during the viewport's layout-phase attach is never lost
 * to a late binding (issue #598). Detach/dispose publish ready=false through
 * the same adapter, so no explicit unbind is required.
 */
export function createTerminalRuntimeAdapter(runtime?: SessionRuntime | null): TerminalControllerEvents {
  const store = getDefaultStore();
  return {
    onTransportReady: (ready) => {
      if (runtime) {
        runtime.setTransportReady(ready);
      } else {
        // Compatibility for isolated controller consumers. Production terminal
        // paths always inject their SessionRuntime.
        store.set(terminalTransportReadyAtom, ready);
      }
    },
    onInputModeChange: (sid, mode) => {
      store.set(inputModeAtomFamily(sid), mode);
    },
    onResize: (_sid, cols, rows) => {
      if (runtime) {
        runtime.updateViewportSize({ cols, rows });
      } else {
        store.set(lastResizeAtom, { cols, rows });
      }
    },
  };
}
