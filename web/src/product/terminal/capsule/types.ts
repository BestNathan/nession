import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CapabilityDisclosureEntry, CapabilityId } from '@/product/capability';

export type CapsuleExperience = 'web' | 'app';

/**
 * What a body hands the host to open its overlay (#1120).
 *
 * Defined here, beside the host that renders it, rather than in the app layer
 * that wires capabilities together: the overlay is the capsule's primitive, and
 * a capability reaching for its content type through the surface that owns it
 * is the same direction every other contribution already takes.
 *
 * `title` is required rather than optional because it is the overlay's
 * accessible name, and a dialog without one is a trap for anyone not reading
 * the screen. Browsers warn about it and nothing enforces it, so the type does.
 */
export interface CapsuleDetail {
  content: ReactNode;
  title: string;
}

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
/**
 * One capability row's display identity in the Context Capsule (#1347 SC-19).
 *
 * The registry's entry plus the glyph the **app layer** resolved from the
 * capability's Terminal projection binding (`app/capsuleProjections`) — the
 * glyph cannot be looked up here, because which glyph speaks for a capability
 * is app-layer knowledge and product code does not reach into it. Absent is
 * legal: a capability with no projection has no glyph to contribute, and the
 * row keeps the slot empty so titles stay aligned.
 */
export type CapsuleCapabilityEntry = CapabilityDisclosureEntry & { icon?: LucideIcon };

/**
 * One sensed capability, as the Context Capsule renders it (#1347 SC-19).
 *
 * Built by the composition that knows both halves — the sense (a work signal, a
 * context signal) and the capability's display identity — because neither the
 * sensing layer nor the capability owns both. `title` and `icon` are the
 * capability's *display* identity, never its raw id as product copy; `reason` is
 * the one line saying why it is here.
 */
export interface SensedCapabilityItem {
  capabilityId: CapabilityId;
  title: string;
  icon?: LucideIcon;
  reason: string;
}

export interface CapsuleCapabilityDisclosure {
  entries: readonly CapsuleCapabilityEntry[];
  /**
   * Context-sensed capabilities, already resolved to display items (#1347
   * SC-37/40). The composer of this object knows the surface's experience and
   * the session; the capsule merges these with the work-sensed items and shows
   * one sensed section — it never learns *why* an item is there.
   */
  sensedContext?: readonly SensedCapabilityItem[];
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
 * capability states what it is and Nession decides that it appears at all and
 * where. There is one of these per emergence and one form for it to take: the
 * resolver decides *which* capability shows, and nothing else.
 */
export interface CapsuleCapabilityProjection {
  id: CapabilityId;
  title: string;
  /**
   * The capability's own content.
   *
   * A render prop rather than an element because the frame owns the selection
   * the body produces: the Peek lets the user pick a changed file, and that
   * pick is what the frame's Workspace handoff carries.
   */
  body: (
    focus: string | undefined,
    setFocus: (id?: string) => void,
    /**
     * What a body can *do*, as opposed to what it draws.
     *
     * `sendText` is the capsule's own way of reaching the terminal. `openWorkspace`
     * is #1046's inversion: the host used to render this as a footer on every
     * Peek, and now supplies it and lets the capability decide whether it exists,
     * where it sits, and what it carries. Omitting the argument deepens at the
     * item the body last reported through `onFocusChange`, which is what the
     * footer did — the host still owns that selection, because it is what makes
     * the transition land on the right thing (#826).
     *
     * `openDetail` is the same inversion one level down (#1120): a body that
     * needs to show something *beside* the Terminal hands the host content and
     * gets the approved overlay, rather than portalling for itself. The content
     * type is the host's, so a capability cannot invent a placement.
     */
    actions: {
      sendText: (text: string) => void;
      sendPhysKey?: (key: {
        seq?: string;
        semanticKey?: import('@/platform/terminal-runtime/interaction/TerminalInteractionController').TerminalSemanticKey;
      }) => void;
      openWorkspace: (resourceId?: string) => void;
      openDetail: (detail: CapsuleDetail) => void;
      disabled: boolean;
    },
  ) => ReactNode;
  onDismiss: () => void;
  /** Present when the capability has somewhere deeper to go. */
  onOpenWorkspace?: (resourceId?: string) => void;
  /**
   * Whether this projection claims the soft keyboard while it is up (#1034).
   *
   * Read back from the capability's own binding, not derived here: the capsule
   * has no capability ids and must not grow any, so a projection that needs the
   * keys (Terminal Keys) and one that is read while typing (Git's) are told
   * apart by the capability declaring which it is.
   *
   * Absent means the composer keeps input focus — a capability that has not
   * asked for the keyboard never has it taken away.
   */
  ownsInputFocus?: boolean;
}
