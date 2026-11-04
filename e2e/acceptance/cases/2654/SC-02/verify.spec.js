'use strict';
// #2654 SC-02: the binding draft is one ordered, replace-whole selection.
// Add, reorder and remove mutate only the draft; the preview exposes key
// counts and overlapping key names without values; Cancel leaves the live
// Session untouched; Apply commits once and the Session reports the result.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const STAGING_KEY = 'server::staging.env';
const PROD_KEY = 'agent:devbox-01:prod.env';

test('SC-02: draft, reorder, preview and one replace-whole Apply; Cancel is inert', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=env');
  await expect(page.getByTestId('env-session-environment')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');

  // Cancel sends nothing: remove the only profile, cancel, and the Session
  // still has its original binding.
  await page.getByTestId('env-manage-binding').click();
  await expect(page.getByTestId('env-binding-draft')).toBeVisible();
  await expect(page.getByTestId('env-draft-apply')).toBeDisabled();
  await page.getByTestId('env-draft-remove-' + STAGING_KEY).click();
  await expect(page.getByTestId('env-draft-empty')).toBeVisible();
  await page.getByTestId('env-draft-cancel').click();
  await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
  await expect(page.getByTestId('env-session-profile-' + STAGING_KEY)).toBeVisible();

  // Build an ordered selection in one draft.
  await page.getByTestId('env-manage-binding').click();
  await page.getByTestId('env-draft-add-' + PROD_KEY).click();
  const preview = page.getByTestId('env-draft-preview');
  await expect(preview).toContainText('8 effective variables');
  await expect(preview).toContainText('2 overlapping keys: NODE_ENV, LOG_LEVEL');
  await expect(preview).toContainText(
    'Changed keys: NODE_ENV, LOG_LEVEL, DATABASE_URL, DB_PASSWORD',
  );
  // Key names and counts only — never a value.
  await expect(preview).not.toContainText('staging-secret-9f2c7d');
  await expect(preview).not.toContainText('prod-password-77');

  // Reorder changes the effective result: with staging last, the overlapping
  // keys fall back to staging's current values, so only prod's own keys stay
  // changed.
  await page.getByTestId('env-draft-up-' + PROD_KEY).click();
  await expect(page.getByTestId('env-draft-profiles').locator('li').first())
    .toContainText('prod.env');
  await expect(preview).toContainText('Changed keys: DATABASE_URL, DB_PASSWORD');
  await page.getByTestId('env-draft-down-' + PROD_KEY).click();
  await expect(page.getByTestId('env-draft-profiles').locator('li').first())
    .toContainText('staging.env');

  // Apply commits once; the draft is spent and the Session shows the result.
  await page.getByTestId('env-draft-apply').click();
  await expect(page.getByTestId('env-binding-draft')).toHaveCount(0);
  await expect(page.getByTestId('env-session-status')).toHaveAttribute(
    'data-status', 'pending_shell',
  );
  await expect(page.getByTestId('env-session-status-title')).toHaveText(
    'Waiting for the next shell prompt',
  );
  await expect(page.getByTestId('env-session-profile-' + STAGING_KEY)).toBeVisible();
  await expect(page.getByTestId('env-session-profile-' + PROD_KEY)).toBeVisible();

  // The revision advanced once, not once per profile.
  await page.getByTestId('env-session-details').click();
  const details = page.getByTestId('env-session-details-body');
  await expect(details).toContainText('Desired revision');
  await expect(details.locator('dd').first()).toHaveText('4');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Cancel after removing the only profile left the Session in ' +
      'sync with staging.env; the draft added prod.env, previewed 8 effective keys / 2 overlaps / ' +
      'changed key names without values, reordered both ways, and Apply returned one pending-shell ' +
      'Session with desired revision 4 and two mounted profiles',
  });
});
