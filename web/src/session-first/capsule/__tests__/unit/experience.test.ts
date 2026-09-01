import { describe, it, expect } from 'vitest';
import {
  CAPSULE_EXPERIENCE,
  KNOWN_CAPSULE_TOKEN_IDS,
} from '@/session-first/capsule/config/experience';

describe('CAPSULE_EXPERIENCE', () => {
  it('references only known token id strings', () => {
    for (const config of Object.values(CAPSULE_EXPERIENCE)) {
      expect(config.controlMd).toMatch(/^experience\.(web|app)\./);
      expect(config.composerLineHeight).toMatch(/^experience\.(web|app)\.composer\./);
      expect(config.radiusCapsule).toBe('semantic.radius.capsule');
      expect(config.capsuleSurface).toBe('domain.terminal.capsuleSurface');
      expect(KNOWN_CAPSULE_TOKEN_IDS.has(config.motionComposer)).toBe(true);
    }
  });

  it('freezes desktop History + Send only on web input', () => {
    expect(CAPSULE_EXPERIENCE.web.inputControls).toEqual({
      history: true,
      commands: false,
      paste: false,
      copy: false,
      send: true,
      modeToggle: false,
    });
  });

  it('enables app paste/copy and mode toggle', () => {
    expect(CAPSULE_EXPERIENCE.app.inputControls.paste).toBe(true);
    expect(CAPSULE_EXPERIENCE.app.inputControls.modeToggle).toBe(true);
    expect(CAPSULE_EXPERIENCE.app.supportsCommandsMode).toBe(true);
  });
});
