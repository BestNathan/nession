'use strict';
// #2663 SC-02: the plain `+` still drives the existing Context Capsule — open
// and close, accessible name, keyboard activation, Escape and outside-pointer
// dismissal, focus return, and a route to every available capability's Peek.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openCapsuleFixture, openDisclosure, disclosureRows,
} = require('../../../shared/capsule-cases.cjs');

test('SC-02: the + opens the disclosed capabilities and their Peeks without regressing', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed = [];

  for (const experience of ['web', 'app']) {
    await openCapsuleFixture(page, experience);
    const trigger = page.getByTestId('capsule-capability-more');
    await expect(trigger).toHaveAccessibleName('More capabilities');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Keyboard activation, not only a pointer click.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const surface = page.getByTestId('capsule-context-disclosure');
    await expect(surface).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Escape closes and returns focus to the trigger it came from.
    await page.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.activeElement ===
      document.querySelector('[data-testid="capsule-capability-more"]'))).toBe(true);

    // A pointer outside closes; the trigger toggles it again.
    await openDisclosure(page);
    await page.locator('[data-testid="terminal-surface"]').click({ position: { x: 20, y: 20 } });
    await expect(surface).toHaveCount(0);

    // Every offered capability is reachable, and choosing one opens its Peek.
    const disclosure = page.getByTestId('capsule-context-disclosure');
    const ensureOpen = async () => {
      if ((await disclosure.count()) === 0) {
        await openDisclosure(page);
      }
    };
    await ensureOpen();
    const rows = await disclosureRows(page);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      await ensureOpen();
      await page.getByTestId(row.testId).click();
      await expect(page.getByTestId('capsule-capability-projection'),
        row.testId + ' must open a Peek').toBeVisible();
      // The Peek has its own explicit dismiss control; Escape is the
      // disclosure's (asserted above), not the Peek's.
      await page.getByTestId('capsule-capability-dismiss').click();
      await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
    }
    observed.push(experience + ': ' + rows.length + ' capabilities reachable and each Peek opened');
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': on Web and App the + kept its accessible name and ' +
      'aria-expanded contract, opened by keyboard and pointer, closed by Escape (focus returned) ' +
      'and outside pointer, and every offered capability row opened its Peek and dismissed via its ' + 'own control; ' +
      observed.join('; '),
  });
});
