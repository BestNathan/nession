/**
 * Terminal Keys — a capability of the Terminal and of nothing else (`#826` §7).
 *
 * ## Why this is not under `capabilities/`
 *
 * It was, and the layer gate rejected it: a capability slice may import only
 * from `platform` and `shared`, and everything this one is made of — the key
 * row, the chord, the capsule it projects through — is `product/terminal`
 * machinery. There is no transport to own and no Workspace view to contribute,
 * which is what the `capabilities/` slices have in common; what is left is a
 * Terminal concept, so it lives with the Terminal's other concepts.
 *
 * The app layer still decides that it appears, and where. This states what it
 * is.
 *
 * No JSX here on purpose — `react-refresh/only-export-components` wants a file
 * to export either components or things, and this one is things. The accessory
 * is `TerminalKeysProjection`, and since its props are a subset of what a
 * projection body receives, it *is* the body rather than a wrapper around it.
 */
import type { CapabilityState } from '@/product/capability';
import type { CapsuleProjectionBinding } from '@/app/capsuleProjections';
import { TerminalKeysProjection } from '@/product/terminal/TerminalKeysProjection';

export const TERMINAL_KEYS_ID = 'terminal-keys';
export const TERMINAL_KEYS_TITLE = 'Terminal Keys';

/**
 * Reachable wherever there is a terminal to type into, and nowhere else.
 *
 * No transport, no discovery, no state to observe: the only question is whether
 * a Session exists for the keys to reach.
 */
export function resolveTerminalKeysState(sessionId: string | undefined): CapabilityState {
  return sessionId ? 'available' : 'unavailable';
}

export const terminalKeysProjection: CapsuleProjectionBinding = {
  id: TERMINAL_KEYS_ID,
  // Nothing to add at Peek and no Workspace view to open: the accessory is the
  // capability in full, which is the lower bound `capability-emergence.md`
  // allows a Terminal-local capability to stop at.
  body: TerminalKeysProjection,
};
