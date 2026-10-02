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
