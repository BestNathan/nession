export type CapsuleMode = 'input' | 'commands';

/** @deprecated Use CapsuleExperience — desktop≡web, mobile≡app */
export type CapsuleVariant = 'desktop' | 'mobile';

export type CapsuleExperience = 'web' | 'app';

export type CapsulePopoverId = 'history' | 'commands';

/** Content-driven Input composer layout (spec: flat-stacked). */
export type ComposerLayout = 'flat' | 'stacked';

/** @deprecated Use ComposerLayout — single≡flat, multi≡stacked */
export type DockHeight = 'single' | 'multi';

export {
  dockHeightFromLayout,
  layoutFromLineCount,
} from '@/features/terminal/capsule/measure/layoutFromLineCount';

export function experienceFromVariant(variant: CapsuleVariant): CapsuleExperience {
  return variant === 'mobile' ? 'app' : 'web';
}

/**
 * Lightweight presence a capability may earn in the capsule.
 *
 * The type admits only `relevant` / `active` on purpose: `available` earns no
 * resting presence and `unavailable` earns none at all, so the capsule cannot
 * be handed a capability that has not earned its place.
 */
export interface CapsuleCapabilityPresence {
  id: string;
  label: string;
  state: 'relevant' | 'active';
  onActivate: () => void;
}
