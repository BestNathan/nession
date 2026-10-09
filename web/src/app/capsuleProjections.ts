import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CapabilityId, CapabilityState } from '@/product/capability';
import type { CapsuleDetail } from '@/product/terminal/capsule/types';
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
 * Nession decides whether anything appears at all. That is
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
   * The capability's glyph in the Terminal.
   *
   * This surface's own declaration, not a lookup performed against the
   * capability's Workspace view binding: the capsule lists a capability that
   * has no Workspace view at all (Terminal Keys), and a row that cannot find
   * an icon draws an empty column where the others draw identity. What the
   * value is, is the capability's to decide — one whose view declares the same
   * glyph references it (`icon: gitView.icon`) rather than restating it, so
   * there is one Git glyph in the tree; one with nothing to reference declares
   * its own.
   */
  icon: LucideIcon;
  /**
   * Whether this projection claims the soft keyboard while it is up (#1034).
   *
   * The keyboard is the contested resource, and it is contested asymmetrically.
   * A projection the user *taps* to drive the terminal — Terminal Keys — cannot
   * share the screen with an IME: the keyboard would cover the accessory it is
   * competing with, and every key the user wants is behind it. A projection that
   * is meant to be read *while* typing — Git's Peek, for a
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
    /**
     * The lifecycle state Nession resolved for this capability.
     *
     * The second implementation asked for it. Claude Code's body says
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
    sendPhysKey?: (key: {
      /** Raw bytes; absent on a key the runtime encodes from terminal state. */
      seq?: string;
      semanticKey?: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalSemanticKey;
    }) => void;
    /**
     * The host's routing into the Workspace, for the body's *content* rows —
     * a conversation candidate that opens itself, at the item it names or the
     * one the body last reported.
     *
     * Routing only. The Workspace *destination* — whether the action exists,
     * where it sits, what it looks like — is drawn by `PeekHost` itself
     * (#1347 SC-21: "Peek header and Workspace destination are
     * Nession-owned"), with presence decided from the app layer's Workspace
     * view registry. `#1046`'s body-owns-the-action model is superseded on
     * that point: a body must not render its own "Open in Workspace"
     * affordance, or every capability ends up re-deciding chrome the host
     * already owns. What a body may do is navigate from its content — the
     * row is the capability's, the routing is the host's.
     */
    openWorkspace: (resourceId?: string) => void;
    /**
     * Open the host's approved child overlay with this content (#1120).
     *
     * The same split as `openWorkspace`, one level down: the capability says
     * *what* to show and the host owns *how* — the surface, its placement, its
     * dismissal and its accessible name. `#1120` requires that a capability
     * cannot portal for itself, and this is how it gets an overlay without one:
     * a body free to place its own `position: fixed` would be a second layout
     * system running beside the shell's.
     *
     * **One level only.** The overlay has no way to open another, which is how
     * "not a second Workspace" is enforced rather than merely intended.
     */
    openDetail: (detail: CapsuleDetail) => void;
    disabled: boolean;
  }) => ReactNode;
}


/**
 * Capabilities that can say anything in the Terminal, in registration order.
 *
 * Only these are offered in the capability entry, and choosing one of them opens
 * its Peek. Everything else keeps the behaviour it had: choosing it opens its
 * Workspace view. A capability absent from this list is not broken — it simply
 * has no Terminal projection of its own, which is exactly what
 * `capability-emergence.md` means by a Terminal-local capability stopping at the
 * Terminal.
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
 * The capability's **Terminal projection** glyph, or undefined for one with no
 * projection.
 *
 * Named for the registry it reads: `projectionIconFor('files')` is undefined
 * because Files has a Workspace view and no Terminal projection — this is not
 * "the capability's icon", which the Workspace view binding answers.
 *
 * Resolves through `projectionBindingFor` rather than repeating its lookup:
 * there is one rule for "which binding speaks for this id", and a second
 * `.find` here would be a copy free to disagree with it.
 */
export function projectionIconFor(id: CapabilityId): LucideIcon | undefined {
  return projectionBindingFor(id)?.icon;
}

/**
 * Every capability that can be drawn beside the capsule.
 *
 * This was two lists. `#1046` split "can be drawn" from "is worth offering"
 * so a Signal-only binding could emerge on its own without being offered for
 * explicit selection — and with Signal gone, every binding declares a Peek,
 * so the filter that expressed the difference excluded nothing. One list,
 * because there is one answer.
 */
export const CAPSULE_PROJECTION_IDS: readonly CapabilityId[] = CAPSULE_PROJECTIONS.map(
  (binding) => binding.id,
);

export { CLAUDE_CODE_ID, GIT_ID, TERMINAL_KEYS_ID };
