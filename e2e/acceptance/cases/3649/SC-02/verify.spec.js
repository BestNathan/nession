'use strict';
// #3649 SC-02: Project -> Create Session previews the inherited ordered ENV,
// supports an explicit custom replacement and No environment, and keeps the
// effective selection correct across mode switches, errors, close/reopen,
// Agent and Project context. App has one current-depth Back/Header and usable
// touch geometry; Web works at 1180/1024.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openProjectCreate(page, route) {
  await page.goto(route);
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByTestId('create-session-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('SC-02: Web distinguishes inherit, custom and no environment', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await openProjectCreate(page, '/#/fixture?projects=canonical&env=project-env');
  await expect(dialog.getByRole('heading', { name: /Create Session in/ })).toContainText(
    'Nession',
  );
  await expect(dialog.getByTestId('env-mode-inherit').getByRole('radio')).toBeChecked();
  await expect(dialog.getByTestId('env-effective-origin')).toHaveText('From Project defaults');
  await expect(dialog.getByTestId('env-effective-item-0')).toContainText('staging.env');

  // Keyboard: the native radio group moves the selection without a pointer.
  await dialog.getByTestId('env-mode-inherit').getByRole('radio').focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByTestId('env-mode-custom').getByRole('radio')).toBeChecked();
  await expect(dialog.getByTestId('env-effective-origin')).toHaveText('Explicit replacement');
  await expect(dialog.getByTestId('env-effective-empty')).toBeVisible();

  await dialog.getByText('prod.env').click();
  await dialog.getByText('local.env').click();
  await expect(dialog.getByTestId('env-effective-item-0')).toContainText('prod.env');
  await expect(dialog.getByTestId('env-effective-item-1')).toContainText('local.env');
  await dialog.getByTestId('env-selected-up-agent:devbox-01:local.env').click();
  await expect(dialog.getByTestId('env-effective-item-0')).toContainText('local.env');
  await expect(dialog.getByTestId('env-effective-item-1')).toContainText('prod.env');

  await dialog.getByTestId('env-mode-none').click();
  await expect(dialog.getByTestId('env-effective-origin')).toHaveText('Explicit empty');
  await expect(dialog.getByTestId('env-effective-empty')).toBeVisible();

  // Close/reopen resets to the Project default and does not keep the old custom set.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByTestId('project-detail-create-session').click();
  const reopened = page.getByTestId('create-session-dialog');
  await expect(reopened.getByTestId('env-mode-inherit').getByRole('radio')).toBeChecked();
  await expect(reopened.getByTestId('env-effective-origin')).toHaveText('From Project defaults');
  await expect(reopened.getByTestId('env-effective-item-0')).toContainText('staging.env');
  await expect(reopened.getByTestId('env-effective-item-1')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1440 previewed From Project defaults [staging.env], moved to ' +
      'Custom via keyboard, ordered [local.env, prod.env], chose Explicit empty, and reopened ' +
      'to the Project default without retaining the custom selection',
  });
});

test('SC-02: an Agent change keeps the effective Project default', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1180, height: 900 });
  const dialog = await openProjectCreate(page, '/#/fixture?projects=long&env=project-env');
  const trigger = dialog.getByTestId('project-location-trigger');
  await expect(trigger).toContainText('macbook');
  await expect(dialog.getByTestId('env-effective-item-0')).toContainText('staging.env');

  await trigger.click();
  await page.getByRole('option').nth(1).click();
  await expect(trigger).toContainText('devbox-01');
  await expect(dialog.getByTestId('env-effective-origin')).toHaveText('From Project defaults');
  await expect(dialog.getByTestId('env-effective-item-0')).toContainText('staging.env');
  await expect(dialog.getByTestId('env-effective-missing-0')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': switching the Existing Location from macbook to devbox-01 kept ' +
      'the same Server-scoped Project default staging.env and reported no missing reference',
  });
});

test('SC-02: a missing inherited reference blocks Create visibly', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  await page.setViewportSize({ width: 1180, height: 900 });
  const dialog = await openProjectCreate(page, '/#/fixture?projects=missing-env&env=project-env');
  await dialog.locator('#name').fill('missing-default');
  await expect(dialog.getByTestId('env-effective-missing-1')).toBeVisible();
  await dialog.getByTestId('create-session-submit').click();
  await expect(dialog.getByTestId('create-session-error')).toContainText(
    'Cannot create Session: missing.env unavailable',
  );

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the create preview marked missing.env and Create refused with ' +
      '"Cannot create Session: missing.env unavailable" rather than falling back',
  });
});

for (const width of [1180, 1024]) {
  test(`SC-02: Web create modes fit at ${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    const { sha } = verifiedRuntime('SC-02');
    await page.setViewportSize({ width, height: 900 });
    const dialog = await openProjectCreate(page, '/#/fixture?projects=canonical&env=project-env');
    for (const id of ['env-mode-inherit', 'env-mode-custom', 'env-mode-none']) {
      const box = await dialog.getByTestId(id).boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
    }
    const preview = await dialog.getByTestId('env-effective-preview').boundingBox();
    expect(preview).not.toBeNull();
    expect(preview.x + preview.width).toBeLessThanOrEqual(width + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width + 1,
    );

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': Web ' + width + ' kept all three mode choices and the ' +
        'effective preview inside the viewport with no horizontal page overflow',
    });
  });
}

for (const width of [390, 375]) {
  test(`SC-02: App keeps one header and usable modes at ${width}`, async ({ page }) => {
    test.setTimeout(240_000);
    const { sha } = verifiedRuntime('SC-02');
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#/fixture/app?projects=canonical&env=project-env');
    await page.getByTestId('app-header-sessions').first().click();
    await page.getByTestId('project-item-row').first().click();
    const detail = page.getByTestId('app-project-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('app-page-header')).toHaveCount(1);

    await page.getByTestId('project-detail-create-session').click();
    const formPage = page.getByTestId('app-create-session-page');
    await expect(formPage).toBeVisible();
    await expect(formPage.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('app-session-env')).toContainText('Use Project defaults');
    await expect(page.getByTestId('app-session-env')).toContainText('staging.env');

    await page.getByTestId('app-session-env').click();
    const envPage = page.getByTestId('app-create-env-page');
    await expect(envPage).toBeVisible();
    await expect(envPage.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('app-env-mode-inherit').getByRole('radio')).toBeChecked();
    await expect(page.getByTestId('app-env-effective-preview')).toContainText(
      'From Project defaults',
    );
    await expect(page.getByTestId('app-env-effective-preview')).toContainText('staging.env');

    for (const id of ['app-env-mode-inherit', 'app-env-mode-custom', 'app-env-mode-none']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box).not.toBeNull();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
    }

    await page.getByTestId('app-env-mode-none').click();
    await expect(page.getByTestId('app-env-effective-preview')).toContainText('Explicit empty');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width + 1,
    );

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': App ' + width + ' showed one header at Project detail, create ' +
        'form and Environment depth; each mode choice was >=44px and inside the viewport; ' +
        'No environment reported Explicit empty with no horizontal overflow',
    });
  });
}
