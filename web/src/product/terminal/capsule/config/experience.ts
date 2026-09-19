import type { CapsuleExperience } from '@/product/terminal/capsule/types';

export interface CapsuleControlSlots {
  history: boolean;
  commands: boolean;
  paste: boolean;
  copy: boolean;
  send: boolean;
  modeToggle: boolean;
}

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
  inputControls: CapsuleControlSlots;
  supportsCommandsMode: boolean;
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
    inputControls: {
      history: true,
      commands: false,
      paste: false,
      copy: false,
      send: true,
      modeToggle: false,
    },
    supportsCommandsMode: false,
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
    inputControls: {
      history: true,
      commands: false,
      paste: true,
      copy: true,
      send: true,
      modeToggle: true,
    },
    supportsCommandsMode: true,
  },
};
