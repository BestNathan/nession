'use strict';
// #2663 SC-03: a foreground `claude`/`claude.exe` proves the CLI is OPEN in the
// Session. The capability stays discoverable as active, but no `working` status
// and no "Working in this session" copy is produced by process presence alone.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openCapsuleFixture, openDisclosure, disclosureRows, readTrigger,
} = require('../../../shared/capsule-cases.cjs');

test('SC-03: CLI presence is discoverable without claiming work', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  const observed = [];

  for (const experience of ['web', 'app']) {
    // Idle Session: Claude Code is still an offered capability.
    await openCapsuleFixture(page, experience);
    await openDisclosure(page);
    const idle = (await disclosureRows(page))
      .find((row) => row.testId === 'capsule-capability-picker-claude-code');
    expect(idle, experience + ': Claude Code is always discoverable').toBeTruthy();
    expect(idle.state).toBe('available');
    await page.keyboard.press('Escape');

    // Foreground CLI: active presence, no work claim anywhere.
    await openCapsuleFixture(page, experience, '?pane=claude.exe');
    await openDisclosure(page);
    const open = (await disclosureRows(page))
      .find((row) => row.testId === 'capsule-capability-picker-claude-code');
    expect(open.state, experience + ': the CLI-open pane reads as active').toBe('active');
    expect(open.text).toContain('Claude');
    // Not a sensed work row, and not the working copy.
    await expect(page.getByTestId('capsule-context-item-claude-code')).toHaveCount(0);
    await expect(page.getByText('Working in this session')).toHaveCount(0);
    await expect(page.getByTestId('work-ring')).toHaveCount(0);
    expect((await readTrigger(page)).ringCount).toBe(0);
    observed.push(experience + ': available → active, no sensed/work claim');
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': on Web and App a plain Session listed Claude Code ' +
      'as available and a pane running claude.exe listed it as active; neither state rendered ' +
      'a sensed work row, "Working in this session" copy, or a work ring (' + observed.join('; ') +
      '); the runtime half runs the source-aligned sense suites',
  });
});
