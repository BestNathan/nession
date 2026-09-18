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
      // Both sinks, always. `useSessionRuntime` reads this atom and feeds it
      // into the runtime config, which `updateContext` applies back onto the
      // runtime — so publishing to only one of them lets that config sync
      // clobber what this adapter just set. That is what pinned the attach phase
      // at 'connecting' after a successful relay attach: the adapter set
      // ready=true on the runtime, the next config update pushed the atom's
      // stale `false` back over it, and `driveRelayAttach` then early-returned
      // on `!transportReady` forever — so every keystroke sat in
      // ConnectionManager's inputBuffer and was never sent.
      store.set(terminalTransportReadyAtom, ready);
      if (runtime) {
        runtime.setTransportReady(ready);
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
