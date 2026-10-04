import type { CapabilityState } from '@/product/capability';

/**
 * The lifecycle state, said out loud rather than shown as a dot.
 *
 * `active` is the pane running it right now; `relevant` is that it ran here
 * earlier — the distinction `resolveClaudeCodeState` already draws.
 *
 * Lives in `model/` rather than beside the body that draws it: it is the
 * capability's own word for what a state means, so the next surface that shows
 * one reads the same sentence rather than inventing a second.
 */
export function stateLine(state: CapabilityState): string {
  return state === 'active' ? 'Running in this Session' : 'Ran in this Session earlier';
}
