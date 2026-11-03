'use strict';
// #2663 SC-01: in both experiences the `+` is the same plain trigger whether
// the Session is idle, the Claude CLI is open, or a capability reports state —
// and no ambient work ornament is painted anywhere.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openCapsuleFixture, readTrigger, openDisclosure, disclosureRows,
} = require('../../../shared/capsule-cases.cjs');

test('SC-01: the resting + is identical across lifecycle states, with no Work Ring', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-01');
  const observed = [];

  for (const experience of ['web', 'app']) {
    await openCapsuleFixture(page, experience);
    const idle = await readTrigger(page);
    expect(idle.ringCount, 'the healthy state paints no Work Ring').toBe(0);
    expect(idle.svgCount, 'the trigger draws exactly one glyph').toBe(1);
    expect(idle.animations.every((name) => name === 'none'),
      'the resting trigger carries no animation').toBe(true);
    expect(idle.ariaLabel).toBe('More capabilities');

    // Claude CLI open in the pane: the same trigger, byte for byte.
    await openCapsuleFixture(page, experience, '?pane=claude.exe');
    const claudeOpen = await readTrigger(page);
    expect(claudeOpen, experience + ': the + must not change with the CLI open')
      .toEqual(idle);

    // A capability reporting state would be the third input the criterion
    // names. No capability has a verified activity signal today (#2663 ships
    // none), so the open disclosure must not manufacture an ambient or sensed
    // work state from the foreground command either.
    const surface = await openDisclosure(page);
    await expect(surface).toBeVisible();
    const rows = await disclosureRows(page);
    expect(rows.find((row) => row.testId === 'capsule-capability-picker-claude-code')?.state)
      .toBe('active');
    expect(rows.find((row) => row.testId === 'capsule-context-item-claude-code'))
      .toBeUndefined();
    await expect(page.getByText('Working in this session')).toHaveCount(0);
    expect(await readTrigger(page)).toEqual(idle);
    observed.push(experience + ': plain + identical for idle and CLI-open states');
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Web and App triggers rendered identical markup, ' +
      'box (' + observed.length + ' experiences measured) and a single glyph in idle and ' +
      'claude.exe-open states; zero work-ring nodes, zero animation, no sensed work row and no ' +
      '"Working in this session" copy',
  });
});
