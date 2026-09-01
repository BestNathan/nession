import type { CapsuleExperience } from '@/session-first/capsule/types';

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
    composerLineHeight: 'experience.web.composer.lineHeight',
    composerMaxLines: 'experience.web.composer.maxLines',
    composerShellMaxWidth: 'experience.web.composer.shellMaxWidth',
    composerShellInset: 'experience.web.composer.shellInset',
    composerShellSafeArea: 'experience.web.composer.shellSafeArea',
    motionComposer: 'experience.web.motion.composer',
    radiusCapsule: 'semantic.radius.capsule',
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
    composerLineHeight: 'experience.app.composer.lineHeight',
    composerMaxLines: 'experience.app.composer.maxLines',
    composerShellMaxWidth: 'experience.app.composer.shellMaxWidth',
    composerShellInset: 'experience.app.composer.shellInset',
    composerShellSafeArea: 'experience.app.composer.shellSafeArea',
    motionComposer: 'experience.app.motion.composer',
    radiusCapsule: 'semantic.radius.capsule',
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

export const KNOWN_CAPSULE_TOKEN_IDS = new Set(
  Object.values(CAPSULE_EXPERIENCE).flatMap((config) => [
    config.controlMd,
    config.controlSm,
    config.iconMd,
    config.composerLineHeight,
    config.composerMaxLines,
    config.composerShellMaxWidth,
    config.composerShellInset,
    config.composerShellSafeArea,
    config.motionComposer,
    config.radiusCapsule,
    config.capsuleSurface,
  ]),
);
