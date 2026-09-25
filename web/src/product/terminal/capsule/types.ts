import type { ReactNode } from 'react';
import type { CapabilityDisclosureEntry, CapabilityId } from '@/product/capability';

export type CapsuleExperience = 'web' | 'app';

/** The composer's one anchored popover. `commands` was retired with the App
 *  `input | commands` mode (#1034): the capability entry and the Terminal Keys
 *  projection are secondary *surfaces* now, not a second popover. */
export type CapsulePopoverId = 'history';

/** Content-driven Input composer layout (spec: flat-stacked). */
export type ComposerLayout = 'flat' | 'stacked';

/** Docked height, as the shell reports it on `data-dock-height`. */
export type DockHeight = 'single' | 'multi';

export {
  dockHeightFromLayout,
  layoutFromLineCount,
} from '@/product/terminal/capsule/measure/layoutFromLineCount';

/**
 * Lightweight presence a capability may earn in the capsule.
 *
 * The type admits only `relevant` / `active` on purpose: `available` earns no
 * resting presence and `unavailable` earns none at all, so the capsule cannot
 * be handed a capability that has not earned its place.
 */
/**
 * Capabilities the capsule did not give a chip to, reachable on demand.
 *
 * The capsule reports presence; opening a capability stays the app's business,
 * so the app supplies both the entries and what selecting one does.
 */
export interface CapsuleCapabilityDisclosure {
  entries: readonly CapabilityDisclosureEntry[];
  onSelect: (id: CapabilityId) => void;
}

export interface CapsuleCapabilityPresence {
  id: string;
  label: string;
  state: 'relevant' | 'active';
  onActivate: () => void;
}

/**
 * A capability emerging beside the capsule (`docs/design/capability-emergence.md`).
 *
 * The capsule draws the frame and the capability supplies the body, so the
 * capability states what it is and Nession decides that it appears at all, at
 * which depth, and where. `depth` is an input rather than capsule state: the
 * decision was `resolveCapabilityProjection`'s, and a component free to change
 * it would be a second copy of that rule.
 */
export interface CapsuleCapabilityProjection {
  id: CapabilityId;
  title: string;
  depth: 'signal' | 'peek';
  /**
   * The capability's own content for this depth.
   *
   * A render prop rather than an element because the frame owns the selection
   * the body produces: Peek lets the user pick a changed file, and that pick is
   * what the frame's Workspace handoff carries.
   */
  body: (
    focus: string | undefined,
    setFocus: (id?: string) => void,
    /** The capsule's own way of reaching the terminal, for a body that acts. */
    actions: { sendText: (text: string) => void; disabled: boolean },
  ) => ReactNode;
  /**
   * Signal → Peek. Absent for a capability with nothing to add at Peek.
   *
   * The second implementation settled this. Git has two Terminal depths and
   * deepens by tapping its title; a capability whose Signal already says
   * everything the Terminal can say has no Peek to open, and offering one would
   * open an empty surface. The frame drops the step and reaches the Workspace
   * from the Signal instead.
   */
  onDeeper?: () => void;
  onDismiss: () => void;
  /** Present when the capability has somewhere deeper to go. */
  onOpenWorkspace?: (resourceId?: string) => void;
  /**
   * Whether this projection claims the soft keyboard while it is up (#1034).
   *
   * Read back from the capability's own binding, not derived here: the capsule
   * has no capability ids and must not grow any, so a projection that needs the
   * keys (Terminal Keys) and one that is read while typing (Git's Signal and
   * Peek) are told apart by the capability declaring which it is.
   *
   * Absent means the composer keeps input focus — a capability that has not
   * asked for the keyboard never has it taken away.
   */
  ownsInputFocus?: boolean;
}
