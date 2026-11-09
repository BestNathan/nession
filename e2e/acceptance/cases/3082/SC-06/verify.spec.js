'use strict';
// #3082 SC-06: Web Sidebar and App Sessions stay flat; binding/unbinding is
// accessible from Session context on Web (1180/1024) and App (390/375), and
// absence/permission/deleted Project states are explicit and safe.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function associateThroughRowMenu(page, sessionId, projectName) {
  await page.getByTestId(`session-actions-${sessionId}`).click();
  await page.getByTestId(`session-actions-project-${sessionId}`).click();
  await expect(page.getByTestId('session-project-dialog')).toBeVisible();
  await page.getByTestId('session-project-trigger').click();
  await page.getByRole('option', { name: projectName }).click();
  await page.getByTestId('session-project-save').click();
}

test('SC-06: Web associates and removes membership without nesting Sessions', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto('/#/fixture?projects=canonical&sessionProject=bound-ab');

  await page
    .locator('[data-session-row="macbook:dotfiles"]')
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('session-project-chip')).toHaveCount(0);
  await associateThroughRowMenu(page, 'macbook:dotfiles', 'Nession');
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

  await page.getByTestId('session-project-chip').click();
  await page.getByTestId('project-peek-manage').click();
  await page.getByTestId('session-project-trigger').click();
  await page.getByRole('option', { name: 'No Project' }).click();
  await page.getByTestId('session-project-save').click();
  await expect(page.getByTestId('session-project-chip')).toHaveCount(0);

  // Sidebar keeps Sessions and Projects as siblings; no Project parent row.
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.locator('[data-testid="session-item-row"] [data-testid="project-item-row"]'))
    .toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 associated an unbound Session via the row menu, ' +
      'removed it via the Peek, and kept the Session list flat beside Projects',
  });
});

test('SC-06: a deleted Project fails safely and offers the association dialog', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/fixture?projects=canonical&sessionProject=deleted');
  await expect(page.getByTestId('session-project-chip')).toHaveText('Project unavailable');
  await page.getByTestId('session-project-chip').click();
  await expect(page.getByTestId('session-project-dialog')).toBeVisible();
  await expect(page.getByTestId('session-project-selected')).toHaveText('Project unavailable');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1024 rendered an unavailable Project without stale ' +
      'data and opened the explicit membership dialog',
  });
});

test('SC-06: App Sessions expose the same membership action at 375', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/fixture/app?projects=canonical&sessionProject=bound-ab');
  await page.getByTestId('app-header-sessions').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await associateThroughRowMenu(page, 'macbook:dotfiles', 'Nession');
  // Return to the Terminal layer for the Session; the chip is part of it.
  await page
    .locator('[data-session-row="macbook:dotfiles"]')
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 375 kept the flat Sessions list and Projects section; ' +
      'the row menu associated the Session and the Terminal chip resolved it under one header',
  });
});
