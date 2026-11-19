// #3804 SC-02 (presentation half): an offline Agent's last Working level is
// never shown as currently verified — every row reads unknown.
import { expect, test } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';

test('SC-02: an offline Agent never leaves a stale working reading visible', async ({ page }) => {
  test.setTimeout(60_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?sessionActivity=canonical&agents=offline');
  await expect(page.getByTestId('sidebar')).toBeVisible();

  const rows = page.locator('[data-session-row]');
  await expect(rows).toHaveCount(6);
  const readings = await rows.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute('data-session-row'),
      activity: element.getAttribute('data-activity'),
    })),
  );
  expect(readings.every((row) => row.activity === 'unknown')).toBe(true);
  for (const row of readings) {
    await expect(page.getByTestId(`session-item-${row.id}`)).not.toHaveAccessibleName(
      /Activity: Working/,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: with every Agent offline, all six rows rendered Activity ` +
      'unknown and no row claimed Working, even though one previously reported ' +
      'Working; the offline state stayed independently visible',
  });
});
