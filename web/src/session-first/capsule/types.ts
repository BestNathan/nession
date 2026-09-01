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
} from '@/session-first/capsule/measure/layoutFromLineCount';

export function experienceFromVariant(variant: CapsuleVariant): CapsuleExperience {
  return variant === 'mobile' ? 'app' : 'web';
}
