import type { ReactNode } from 'react';
import type { CapabilityId, CapabilityState } from '@/product/capability';
import { CLAUDE_CODE_ID, claudeCodeProjection } from '@/capabilities/claude-code';
import { GIT_ID, gitProjection } from '@/capabilities/git';
import {
  TERMINAL_KEYS_ID,
  terminalKeysProjection,
} from '@/product/terminal/terminalKeys';

/**
 * How a capability supplies its Terminal projection body.
 *
 * The capability contributes **content**; the capsule draws the frame and
 * Nession decides whether anything appears at all and at which depth. That is
 * the split `workspace-navigation.md` draws — "Extensions contribute
 * capability. Nession decides whether, where, and how" — and it is why this is
 * a body renderer rather than a component free to place itself.
 *
 * The exact shape is provisional by design. `#826` Q6 deferred freezing it
 * until a second implementation exists, so this is written to be replaced
 * rather than extended: nothing outside this file and the capability's own
 * `contribution.tsx` depends on its fields.
 */
export interface CapsuleProjectionBinding {
  id: CapabilityId;
  /**
   * What this binding contributes to the capsule, which is what decides whether
   * the capability entry may offer it (#1046).
   *
   * Capsule eligibility is a statement about the **Terminal**, not about the
   * capability having a view somewhere: the entry lists what can be reached
   * from where the user already is. So the role is declared here, beside the
   * body that does the reaching, and it is **required** — a new binding cannot
   * arrive without saying which of the three it is. That is the property
   * `supportsPeek?: boolean` did not have: absent meant "no" for a capability
   * that had never considered the question, and "not yet" for one that had.
   *
   * - `'peek'` — it contributes a Terminal-local Peek. This is the only thing
   *   that earns a capability explicit discovery: "availability in Workspace is
   *   not enough".
   * - `'accessory'` — a built-in Terminal-local accessory rather than a
   *   Workspace capability. It has no Workspace view to be confused with, so
   *   the rule above does not exclude it; it is the entry's own family, and
   *   `#1046`'s edge case keeps it listed so that a node with no Peek-capable
   *   capability does not present an empty menu.
   * - `'signal'` — a Terminal Signal and no Peek. It is **not** listed: it
   *   still emerges by observation when Nession resolves it as relevant, but it
   *   is not offered for explicit selection. Claude Code is the reference case,
   *   and `#1046` is explicit that a Signal-only binding is insufficient for
   *   explicit discovery; it returns to the entry when the plugin contributes a
   *   Peek.
   */
  entry: 'peek' | 'accessory' | 'signal';
  /**
   * Whether this projection claims the soft keyboard while it is up (#1034).
   *
   * The keyboard is the contested resource, and it is contested asymmetrically.
   * A projection the user *taps* to drive the terminal — Terminal Keys — cannot
   * share the screen with an IME: the keyboard would cover the accessory it is
   * competing with, and every key the user wants is behind it. A projection that
   * is meant to be read *while* typing — Git's Signal and Peek, for a
   * `git commit` in progress — has the opposite requirement, and taking the
   * keyboard away from it would be the bug.
   *
   * Only the capability knows which of the two it is, so it says so here rather
   * than the capsule recognising it by id. That is the whole point of the flag:
   * `TerminalCapsule` reacts to this boolean and never learns a capability name,
   * which is what lets a second tap-driven accessory arrive later without
   * touching the capsule.
   *
   * Defaults to false: a capability that has not said it needs the keyboard does
   * not get to take it away from the composer.
   */
  ownsInputFocus?: boolean;
  body: (props: {
    agentId: string | undefined;
    sessionId: string | undefined;
    depth: 'signal' | 'peek';
    /**
     * The lifecycle state Nession resolved for this capability.
     *
     * The second implementation asked for it. Claude Code's Signal says
     * "running now" or "ran earlier", and that is the capability layer's
     * decision — a body re-deriving it from the same facts would be a second
     * copy of `resolveClaudeCodeState` free to disagree with the one the
     * registry used to decide the capability was worth showing at all.
     */
    state: CapabilityState;
    onFocusChange: (resourceId?: string) => void;
    /**
     * How a body reaches the terminal, supplied by the capsule at render time.
     *
     * Not resolved with the rest: the capsule owns the transport, and the
     * registry is built in the shell where no controller exists yet. A
     * capability that needs to *act* on the terminal — Terminal Keys sending a
     * key sequence — gets the way to do it from the surface it is drawn on,
     * which is also what keeps the registry free of transport.
     */
    sendText: (text: string) => void;
    /**
     * Deepen into the Workspace, at the item the body last reported or at one
     * it names (#1046).
     *
     * Supplied by the host and rendered by the capability: the host used to draw
     * this as a footer on every Peek, which made every capability end on the
     * same borrowed sentence. Whether the action exists, where it sits and what
     * it carries are the capability's answers.
     */
    openWorkspace: (resourceId?: string) => void;
    disabled: boolean;
  }) => ReactNode;
}

/**
 * Capabilities that can say anything in the Terminal, in registration order.
 *
 * Only these get a Signal when chosen in the capability entry. Everything else
 * keeps the behaviour it had: choosing it opens its Workspace view. A capability
 * absent from this list is not broken — it simply has no shallower depth to
 * deepen into, which is exactly what `capability-emergence.md` means by a
 * Terminal-local capability stopping at the Terminal.
 */
const CAPSULE_PROJECTIONS: readonly CapsuleProjectionBinding[] = [
  claudeCodeProjection,
  gitProjection,
  terminalKeysProjection,
];

export function projectionBindingFor(id: CapabilityId): CapsuleProjectionBinding | undefined {
  return CAPSULE_PROJECTIONS.find((binding) => binding.id === id);
}

/**
 * Capabilities that have a Terminal depth, for the entry to mark.
 *
 * The capability entry shows every reachable capability; this says which of them
 * will emerge beside the capsule rather than switching surface, so the
 * difference is discoverable before the tap rather than as a surprise.
 */
export const CAPSULE_PROJECTION_IDS: readonly CapabilityId[] = CAPSULE_PROJECTIONS.map(
  (binding) => binding.id,
);

/**
 * Capabilities the entry may offer, which is **not** the list above.
 *
 * `CAPSULE_PROJECTION_IDS` answers "can be drawn beside the capsule"; this
 * answers "is worth offering". They differ by exactly the Signal-only
 * bindings, and that difference is the whole of `#1046`: a capability that can
 * emerge when it becomes relevant is not thereby one the entry should list.
 */
export const CAPSULE_ENTRY_IDS: readonly CapabilityId[] = CAPSULE_PROJECTIONS.filter(
  (binding) => binding.entry !== 'signal',
).map((binding) => binding.id);

export { CLAUDE_CODE_ID, GIT_ID, TERMINAL_KEYS_ID };
