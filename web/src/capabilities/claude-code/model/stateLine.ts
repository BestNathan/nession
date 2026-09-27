import type { CapabilityState } from '@/product/capability';

/**
 * The lifecycle state, said out loud rather than shown as a dot.
 *
 * `active` is the pane running it right now; `relevant` is that it ran here
 * earlier — the distinction `resolveClaudeCodeState` already draws.
 *
 * Lives in `model/` rather than beside one of its callers because **both**
 * depths draw it: the Signal and the Peek are one surface at two depths, and a
 * copy per file is the first place they could come to disagree about what
 * "running" means.
 */
export function stateLine(state: CapabilityState): string {
  return state === 'active' ? 'Running in this Session' : 'Ran in this Session earlier';
}
