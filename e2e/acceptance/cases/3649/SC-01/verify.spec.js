'use strict';
// #3649 SC-01: Project Create/Settings can configure, reorder and remove
// persisted default ENV references without losing unrelated Session defaults.
// Project Detail shows the exact ordered declaration and a missing state with
// no secret values. Web and App share the same component.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SECRET_TEXT = ['staging-secret-9f2c7d', 'project-default', 'API_KEY='];

async function expectNoSecretValues(page) {
  for (const secret of SECRET_TEXT) {
    await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  }
}

test('SC-01: Project Settings edits the ordered Server ENV declaration', async ({ page }) => {
  test.setTimeout(45_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=ordered-env&env=project-env');

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(page.getByTestId('project-env-defaults')).toHaveText(
    'staging.env, shared.env',
  );
  await expectNoSecretValues(page);

  await page.getByTestId('project-detail-settings').click();
  const dialog = page.getByTestId('project-settings-dialog');
  await expect(dialog).toBeVisible();
  const order = dialog.getByTestId('env-selected-order').locator('li');
  await expect(order).toHaveText([/staging\.env/, /shared\.env/]);
  await expectNoSecretValues(page);

  await dialog.getByTestId('env-selected-up-server::shared.env').click();
  await expect(order).toHaveText([/shared\.env/, /staging\.env/]);
  await dialog.getByTestId('env-selected-remove-server::staging.env').click();
  await expect(order).toHaveText([/shared\.env/]);
  await dialog.getByRole('button', { name: 'staging.env server 6 vars' }).click();
  await expect(order).toHaveText([/shared\.env/, /staging\.env/]);

  await dialog.getByTestId('project-settings-submit').click();
  await expect(page.getByTestId('project-settings-dialog')).not.toBeVisible();
  await expect(page.getByTestId('project-env-defaults')).toHaveText(
    'shared.env, staging.env',
  );

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1440 showed the declared order staging.env, shared.env; ' +
      'Settings reordered shared.env before staging.env, removed staging.env, re-added it ' +
      'and persisted shared.env, staging.env; no ENV value or secret text appeared',
  });
});

test('SC-01: Project Create persists optional default references', async ({ page }) => {
  test.setTimeout(45_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?env=project-env');
  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#project-create-name').fill('ENV defaults project');
  await dialog.getByRole('button', { name: 'staging.env server 6 vars' }).click();
  await expect(dialog.getByTestId('env-selected-server::staging.env')).toBeVisible();
  await dialog.getByTestId('project-create-submit').click();

  await expect(page.getByTestId('project-detail-title')).toHaveText('ENV defaults project');
  await expect(page.getByTestId('project-env-defaults')).toHaveText('staging.env');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Project Create persisted an optional Server ENV default and ' +
      'the created Project Detail showed it in declaration order',
  });
});

test('SC-01: Project Detail marks a missing reference without secrets', async ({ page }) => {
  test.setTimeout(45_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?projects=missing-env&env=project-env');

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-env-defaults')).toContainText(
    'staging.env, missing.env',
  );
  await expect(page.getByTestId('project-env-default-missing-1')).toHaveText('(missing)');
  await expectNoSecretValues(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Project Detail rendered staging.env, missing.env in order and ' +
      'marked only the absent reference (missing) without exposing any ENV value',
  });
});

test('SC-01: App Project settings keeps one header and the ordered declaration', async ({ page }) => {
  test.setTimeout(45_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?projects=ordered-env&env=project-env');
  await page.getByTestId('app-header-sessions').first().click();
  await page.getByTestId('project-item-row').first().click();
  const detail = page.getByTestId('app-project-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('app-page-header')).toHaveCount(1);
  await expect(page.getByTestId('project-env-defaults')).toHaveText(
    'staging.env, shared.env',
  );

  await page.getByTestId('project-detail-settings').click();
  const settings = page.getByTestId('app-project-settings-page');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('app-page-header')).toHaveCount(1);
  const order = page.getByTestId('app-project-settings-page').getByTestId('env-selected-order').locator('li');
  await expect(order).toHaveText([/staging\.env/, /shared\.env/]);
  await expectNoSecretValues(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 opened Project Detail and Settings with exactly one ' +
      'current-depth header, showed staging.env, shared.env in order and no horizontal overflow',
  });
});
