import type { CapsuleExperience } from '@/product/terminal/capsule/types';

export interface CapsuleExperienceConfig {
  experience: CapsuleExperience;
  controlMd: string;
  controlSm: string;
  iconMd: string;
  composerLineHeight: string;
  composerMaxLines: string;
  composerShellMaxWidth: string;
  composerShellInset: string;
  composerShellSafeArea: string;
  motionComposer: string;
  radiusCapsule: string;
  capsuleSurface: string;
  /**
   * Whether the experience's own history trigger belongs in the composer row.
   *
   * Web has a pointer and a persistent history affordance; App does not get one
   * at rest (the resting App capsule is `+`, intent, send — nothing else).
   */
  historyControl: boolean;
  /** The resting intent input's placeholder — the sentence the user answers. */
  intentPlaceholder: string;
}

export const CAPSULE_EXPERIENCE: Record<CapsuleExperience, CapsuleExperienceConfig> = {
  web: {
    experience: 'web',
    controlMd: 'experience.web.control.md',
    controlSm: 'experience.web.control.sm',
    iconMd: 'experience.web.icon.md',
    composerLineHeight: 'experience.web.terminalCapsule.lineHeight',
    composerMaxLines: 'experience.web.terminalCapsule.maxLines',
    composerShellMaxWidth: 'experience.web.terminalCapsule.shellMaxWidth',
    composerShellInset: 'experience.web.terminalCapsule.shellInset',
    composerShellSafeArea: 'experience.web.terminalCapsule.shellSafeArea',
    motionComposer: 'experience.web.motion.terminalCapsule',
    radiusCapsule: 'semantic.radius-capsule',
    capsuleSurface: 'domain.terminal.capsuleSurface',
    historyControl: true,
    intentPlaceholder: 'Send input…',
  },
  app: {
    experience: 'app',
    controlMd: 'experience.app.control.md',
    controlSm: 'experience.app.control.sm',
    iconMd: 'experience.app.icon.md',
    composerLineHeight: 'experience.app.terminalCapsule.lineHeight',
    composerMaxLines: 'experience.app.terminalCapsule.maxLines',
    composerShellMaxWidth: 'experience.app.terminalCapsule.shellMaxWidth',
    composerShellInset: 'experience.app.terminalCapsule.shellInset',
    composerShellSafeArea: 'experience.app.terminalCapsule.shellSafeArea',
    motionComposer: 'experience.app.motion.terminalCapsule',
    radiusCapsule: 'semantic.radius-capsule',
    capsuleSurface: 'domain.terminal.capsuleSurface',
    historyControl: false,
    intentPlaceholder: 'Ask Nession…',
  },
};
