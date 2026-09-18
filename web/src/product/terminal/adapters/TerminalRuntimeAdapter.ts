import { getDefaultStore } from 'jotai';
import type { TerminalControllerEvents } from '@/platform/terminal-runtime/controller/TerminalController';
import { inputModeAtomFamily } from '../state/input';
import { lastResizeAtom } from '../state/terminal';
import { terminalTransportReadyAtom } from '../state/transport';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

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
      // TEMPORARY DIAGNOSTIC for the #818 relay regression — remove before merge.
      // `detach()` is the documented source of ready=false and TerminalViewport
      // is its only caller; the stack names whoever triggers it after a
      // successful attach.
      // Log BOTH values: rewireTransport publishes false then true, so knowing
      // the false alone cannot distinguish "rewire completed" from "the true
      // never landed". Only the second is the bug.
      console.log('[diag-ready]', JSON.stringify({
        ready,
        trace: (new Error().stack ?? '').split('\n').slice(2, 6).join(' | '),
      }));
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
