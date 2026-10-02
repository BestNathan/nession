// web/src/product/terminal/state/session.ts
// TerminalStatus/TerminalSession live in platform/terminal-runtime so runtime
// consumers never depend on the Jotai state layer; re-exported here for
// React-side imports.
import type { TerminalStatus } from '@/platform/terminal-runtime/types';
export type { TerminalSession, TerminalStatus } from '@/platform/terminal-runtime/types';

/** Live means attached: every other phase is a form of not-yet or no-longer. */
export function isTerminalLive(state: TerminalStatus): boolean {
  return state === 'attached';
}

/**
 * Current terminal connection status — driven by the attach/disconnect/switch
 * actions in `product/session/state` and the state machine effect in the
 * terminal hooks.
 *
 * Re-exported, not defined: it lives in `platform/attach/state/transport.ts`,
 * below both this module and the `product/session` actions that write it.
 * Defining it here instead makes `product/session/state` and this file import
 * each other — which is what an earlier revision of this refactor did, and it
 * deterministically broke relay-mode terminal I/O in e2e.
 */
export { terminalSessionStateAtom } from '@/platform/attach/state/transport';
