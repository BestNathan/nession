'use strict';
// #2878 SC-02: import a Profile while an older list request is still pending.
// The import's refresh wins; when the older request finally answers with its
// pre-import snapshot, the imported Profile and its selected detail survive.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function waitForHeldList(page) {
  await page.waitForFunction(() => window.fixtureEnv?.isHeld?.() === true);
}

async function importProfile(page) {
  await page.getByTestId('env-new-menu').click();
  await page.getByTestId('env-import').click();
  await expect(page.getByTestId('env-import-dialog')).toBeVisible();
  await page.locator('[data-testid="env-import-dialog"] input[type=file]').setInputFiles({
    name: 'race.env',
    mimeType: 'text/plain',
    buffer: Buffer.from('RACE_PROFILE=1\n'),
  });
  await expect(page.getByTestId('env-import-submit')).toBeEnabled();
  await page.getByTestId('env-import-submit').click();
}

test('SC-02: an imported Profile survives a superseded list answer', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  // Desktop Web Workspace: list row plus the selected profile detail.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=env&env=race');
  await expect(page.getByTestId('env-workspace')).toBeVisible();
  await waitForHeldList(page);
  await importProfile(page);

  const importedRow = page.getByTestId('env-profile-row-server::race.env');
  const importedDetail = page.getByTestId('env-profile-detail');
  await expect(importedRow).toBeVisible();
  await expect(importedDetail).toContainText('race.env');

  // The older request answers with the snapshot it took before the import.
  // Only the current request may publish, so the import stays visible.
  await page.evaluate(() => window.fixtureEnv.releaseList());
  await expect(importedRow).toBeVisible();
  await expect(importedDetail).toContainText('race.env');
  await expect(importedDetail).toContainText('RACE_PROFILE');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  // Narrow App: the import pushes the profile detail over the list. The same
  // late answer must not pop the detail back to a list without the Profile.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?env=race');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-env').click();
  await page.getByTestId('env-new-menu').waitFor();
  await waitForHeldList(page);
  await importProfile(page);

  const appDetail = page.getByTestId('env-profile-detail');
  await expect(appDetail).toContainText('race.env');
  await expect(page.getByTestId('app-page-header')).toContainText('race.env');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  await page.evaluate(() => window.fixtureEnv.releaseList());
  await expect(appDetail).toContainText('race.env');
  await expect(page.getByTestId('app-page-header')).toContainText('race.env');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': an imported race.env was selected while the first list request was ' +
      'held; releasing that older request with its pre-import snapshot left the imported row and ' +
      'selected detail in place on desktop Web and the pushed App detail at 390x844, with no ' +
      'horizontal overflow',
  });
});
