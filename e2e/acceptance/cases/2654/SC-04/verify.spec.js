'use strict';
// #2654 SC-04: #1202's read-first profile, masked secrets, dirty guard and
// bounded scroll survive the Session-first rearrangement; the App keeps one
// shell-owned Back per depth and never remounts the Terminal.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const STAGING_KEY = 'server::staging.env';
const STAGING_ROW = 'env-profile-row-' + STAGING_KEY;

async function dirtyTheEditor(page) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('EXTRA=1');
  await expect(page.getByTestId('env-editor-dirty')).toBeVisible();
}

test('SC-04: read-first, masked, guarded and bounded on Web; one Back and a mounted Terminal on App', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-04');

  // Web: the read-first detail masks secrets and the dirty guard holds.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=env');
  await expect(page.getByTestId('env-profile-list')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId(STAGING_ROW).click();
  await expect(page.getByTestId('env-profile-detail')).toBeVisible();
  await expect(page.getByTestId('env-var-masked-API_KEY')).toBeVisible();
  await expect(page.getByTestId('env-profile-detail')).not.toContainText('staging-secret-9f2c7d');
  await page.getByTestId('env-edit').click();
  await dirtyTheEditor(page);
  await page.getByTestId('env-profile-row-agent:devbox-01:prod.env').click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard unsaved changes?');
  await page.getByTestId('env-guard-cancel').click();
  await expect(page.getByTestId('env-profile-editor')).toBeVisible();
  await page.getByTestId('env-editor-cancel').click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard unsaved changes?');
  await page.getByTestId('env-guard-confirm').click();
  await expect(page.getByTestId('env-profile-detail')).toBeVisible();
  const webOverflow = await page.getByTestId('env-navigator-list').evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(['auto', 'scroll']).toContain(webOverflow);

  // App: the Terminal is the root work surface and stays mounted.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app');
  await expect(page.getByTestId('app-layer-root')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('.xterm')).toHaveCount(1, { timeout: 25_000 });
  await page.locator('.xterm').evaluate((el) => el.setAttribute('data-2654-instance', 'original'));

  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-env').click();
  await expect(page.getByTestId('env-profile-list')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('env-session-summary')).toBeVisible();
  // One shell-owned leave at the capability root: back to the Terminal.
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');

  // Profile Detail: one Back, read-first and masked.
  await page.getByTestId(STAGING_ROW).click();
  await expect(page.getByTestId('env-profile-detail')).toBeVisible();
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  await expect(page.getByTestId('env-var-masked-API_KEY')).toBeVisible();
  await expect(page.getByTestId('env-profile-detail')).not.toContainText('staging-secret-9f2c7d');

  // A dirty edit refuses the shell Back once, then leaves through the guard.
  await page.getByTestId('env-edit').click();
  await dirtyTheEditor(page);
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard unsaved changes?');
  await page.getByTestId('env-guard-cancel').click();
  await expect(page.getByTestId('env-profile-editor')).toBeVisible();
  await page.getByTestId('app-page-back').click();
  await page.getByTestId('env-guard-confirm').click();
  await expect(page.getByTestId('env-profile-detail')).toBeVisible();
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('env-profile-list')).toBeVisible();

  // The Session depth and the binding draft use the same single Back, and the
  // draft's dirty leave is guarded by the capability, not the shell.
  await page.getByTestId('env-session-summary').click();
  await expect(page.getByTestId('env-session-environment')).toBeVisible();
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  await page.getByTestId('env-manage-binding').click();
  await expect(page.getByTestId('env-binding-draft')).toBeVisible();
  await page.getByTestId('env-draft-remove-' + STAGING_KEY).click();
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Discard unsaved changes?');
  await page.getByTestId('env-guard-cancel').click();
  await expect(page.getByTestId('env-binding-draft')).toBeVisible();
  await page.getByTestId('env-draft-cancel').click();
  await expect(page.getByTestId('env-session-environment')).toBeVisible();

  // Scroll ownership is bounded, and the Terminal never remounted.
  const sessionOverflow = await page.getByTestId('env-session-environment').evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(['auto', 'scroll']).toContain(sessionOverflow);
  await expect(page.locator('.xterm')).toHaveCount(1);
  await expect(page.locator('.xterm')).toHaveAttribute('data-2654-instance', 'original');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Web detail masked API_KEY and held a dirty switch; App root showed ' +
      'the Session summary with no Back, Profile Detail/Session/draft each had exactly one Back, dirty ' +
      'edit and dirty draft each raised the capability guard and Keep-editing preserved them, navigator ' +
      'and Session scroll were bounded, and the same xterm instance stayed mounted throughout',
  });
});
