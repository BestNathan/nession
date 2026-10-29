import { getDefaultStore } from 'jotai';
import type { TerminalControllerEvents } from '@/platform/terminal-runtime/controller/TerminalController';
import { inputModeAtomFamily } from '../state/input';
import { clipboardNoticeAtomFamily } from '../state/ui';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

/** Distinguishes repeated identical notices for one Session surface. */
let clipboardNoticeSequence = 0;

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
    onBootstrapApplied: () => {
      runtime.noteBootstrapApplied();
    },
    // The only production source of a verified parser baseline (#2120). The
    // controller emits it after the current xterm parsed an atomic, complete
    // Agent stream-log prefix; a screen-only/unverified capture never reaches
    // this callback.
    onStreamBaseline: (baseline) => {
      runtime.setVerifiedTerminalBaseline(baseline);
    },
    onStreamEventParsed: (position) => {
      runtime.noteStreamEventParsed(position);
    },
    onStreamTruncated: () => {
      runtime.noteStreamTruncated();
    },
    // The controller replaced its halted xterm (#2196). The runtime owns the
    // repair: it states the gap and drives a fresh attach that requests the
    // bootstrap the empty renderer needs.
    onRendererReplaced: () => {
      runtime.noteRendererReplaced();
    },
    onInputModeChange: (sid, mode) => {
      store.set(inputModeAtomFamily(sid), mode);
    },
    onResize: (_sid, cols, rows) => {
      runtime.updateViewportSize({ cols, rows });
    },
    // A transient clipboard state is UI, so it belongs in the Session's own
    // atom rather than in the imperative controller (#2598).
    onClipboardNotice: (notice) => {
      clipboardNoticeSequence += 1;
      store.set(clipboardNoticeAtomFamily(runtime.sessionId), {
        id: clipboardNoticeSequence,
        notice,
      });
    },
  };
}
