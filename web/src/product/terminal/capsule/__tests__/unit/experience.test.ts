import { describe, it, expect } from 'vitest';
import { CAPSULE_EXPERIENCE } from '@/product/terminal/capsule/config/experience';

/**
 * This block used to be named "references only known token id strings" and
 * checked two things that could not fail:
 *
 *   1. `KNOWN_CAPSULE_TOKEN_IDS.has(config.motionComposer)` — the set was built
 *      with `Object.values(CAPSULE_EXPERIENCE).flatMap(c => [c.motionComposer, …])`,
 *      so the assertion asked whether the config is in the config. Always true.
 *   2. A regex pinned to the *old* namespace
 *      (`/^experience\.(web|app)\.composer\./`), which certified the stale names
 *      rather than catching them — so when #827 renamed the tokens to
 *      `terminalCapsule.*`, the ids here went stale and this test stayed green.
 *
 * They were also unread: `inputControls` is the only property anything takes off
 * an experience config, and these token ids have no consumer. That is recorded
 * here rather than fixed silently — if they are meant to drive styling, wiring
 * them up is the change; until then this test's job is to notice a rename.
 *
 * `terminalCapsule` is the *current* namespace; a future rename must update this
 * list deliberately, which is the point.
 */
describe('CAPSULE_EXPERIENCE', () => {
  it('names token ids in the current namespace', () => {
    for (const config of Object.values(CAPSULE_EXPERIENCE)) {
      const ns = `experience.${config.experience}.terminalCapsule.`;
      for (const id of [
        config.composerLineHeight,
        config.composerMaxLines,
        config.composerShellMaxWidth,
        config.composerShellInset,
        config.composerShellSafeArea,
      ]) {
        expect(id.startsWith(ns)).toBe(true);
      }
      expect(config.controlMd).toBe(`experience.${config.experience}.control.md`);
      expect(config.controlSm).toBe(`experience.${config.experience}.control.sm`);
      expect(config.iconMd).toBe(`experience.${config.experience}.icon.md`);
      expect(config.motionComposer).toBe(`experience.${config.experience}.motion.terminalCapsule`);
      // Hyphen, not dot: the token key is `radius-capsule`, so the id is
      // `semantic.radius-capsule`. The dotted form silently pointed nowhere.
      expect(config.radiusCapsule).toBe('semantic.radius-capsule');
      expect(config.capsuleSurface).toBe('domain.terminal.capsuleSurface');
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
