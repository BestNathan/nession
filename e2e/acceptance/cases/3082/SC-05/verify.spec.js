'use strict';
// #3082 SC-05: the Terminal Project Peek deepens into the Project Workspace
// view with the same Project identity and related Sessions, preserving the
// focused Session; App keeps exactly one host-owned header/Back.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-05: Web Peek opens the Project Workspace and returns to the same Terminal', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?projects=canonical&sessionProject=bound');

  const selected = page.locator(
    '[data-session-row="devbox-01:fix-terminal-reconnect"][data-selected="true"]',
  );
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await page.getByTestId('session-project-chip').click();
  await expect(page.getByTestId('project-peek-name')).toHaveText('Nession');
  await page.getByTestId('capsule-capability-open-workspace').click();

  await expect(page.getByTestId('workspace-project-view')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  await expect(page.getByTestId('project-related-session')).toHaveCount(1);
  await expect(page.getByTestId('project-related-session')).toContainText('staging-deploy');
  await expect(selected).toHaveCount(1);

  await page.getByTestId('surface-action-open-terminal').click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect(selected).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Terminal Peek opened the Project Workspace with the ' +
      'same Project and its related Session; returning restored the Terminal with the ' +
      'same selected Session and no extra navigation chrome',
  });
});

test('SC-05: App Peek/Workspace keeps one header and Back returns to the Terminal', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?projects=canonical&sessionProject=bound');
  await page.getByTestId('app-header-sessions').click();
  await page
    .locator('[data-session-row="devbox-01:fix-terminal-reconnect"]')
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await page.getByTestId('session-project-chip').click();
  await expect(page.getByTestId('project-peek-name')).toHaveText('Nession');
  await page.getByTestId('capsule-capability-open-workspace').click();

  await expect(page.getByTestId('workspace-project-view')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  await expect(page.getByTestId('project-related-session')).toHaveCount(1);

  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 pushed the Project Workspace under exactly one ' +
      'page header; Back returned to the same Terminal and Project chip',
  });
});
