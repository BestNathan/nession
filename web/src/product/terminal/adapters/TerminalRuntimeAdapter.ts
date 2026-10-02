import { getDefaultStore } from 'jotai';
import type { TerminalControllerEvents } from '@/platform/terminal-runtime/controller/TerminalController';
import { inputModeAtomFamily } from '../state/input';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

/**
 * Mirrors imperative TerminalController events to their owners: viewport facts
 * (transport readiness, size) go straight to the SessionRuntime, UI preference
 * (input mode) to Jotai.
 *
 * Injected into the TerminalController at construction (useTerminal), so
 * readiness published during the viewport's layout-phase attach is never lost
 * to a late binding (issue #598). Detach/dispose publish ready=false through
 * the same adapter, so no explicit unbind is required.
 *
 * There is exactly one sink for readiness and size — the runtime (#1309 SC-02).
 * They used to also be written to Jotai atoms that `useSessionRuntime` fed back
 * into the runtime config, and that round-trip clobbered the fresher direct
 * push on every config sync: the atom's stale `false` once pinned a live
 * session at 'connecting' with every keystroke buffered forever. The atoms are
 * gone; the config no longer carries either field.
 */
export function createTerminalRuntimeAdapter(runtime: SessionRuntime): TerminalControllerEvents {
  const store = getDefaultStore();
  return {
    onTransportReady: (ready) => {
      runtime.setTransportReady(ready);
    },
    onInputModeChange: (sid, mode) => {
      store.set(inputModeAtomFamily(sid), mode);
    },
    onResize: (_sid, cols, rows) => {
      runtime.updateViewportSize({ cols, rows });
    },
  };
}
