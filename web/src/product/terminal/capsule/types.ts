import type { CapabilityDisclosureEntry, CapabilityId } from '@/product/capability';

export type CapsuleMode = 'input' | 'commands';

export type CapsuleExperience = 'web' | 'app';

export type CapsulePopoverId = 'history' | 'commands';

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
