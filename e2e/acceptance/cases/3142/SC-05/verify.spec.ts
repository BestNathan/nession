// #3142 SC-05 browser half: a real Chromium walkthrough of the published
// overlay-system mock — Web compact/standard/wide, the anchored child-first
// dismissal, App sheet/operation/switching and the invalid/offline fixtures.
// This is prototype mock evidence, not production Acceptance.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/overlay-system-3142/index.html';

test('SC-05: the published overlay mock exercises roles, stack and App switching', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-05');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  const product = page.locator('#nession-product');
  await expect(product).toBeVisible();
  await expect(product).toHaveAttribute('data-experience', 'web');

  // Web standard operation, with an anchored child that dismisses first.
  await product.locator('.entry [data-action="session"]').click();
  const session = product.locator('.dialog.standard');
  await expect(session).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth) + 1);
  await session.locator('[data-action="location-menu"]').click();
  await expect(product.locator('[role="listbox"]')).toBeVisible();
  await product.locator('[data-action="pick-beta"]').click();
  await expect(session.locator('[data-action="location-menu"]')).toContainText('Agent beta');
  await session.locator('[data-action="env-menu"]').click();
  await expect(product.locator('[role="listbox"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(product.locator('[role="listbox"]')).toHaveCount(0);
  await expect(session).toBeVisible();
  await session.locator('.dialog-foot [data-action="close"]').click();
  await expect(product.locator('.dialog')).toHaveCount(0);

  // Wide operation with the long fixture: one body scroll, stable chrome.
  await page.locator('[data-fixture="long"]').click();
  await product.locator('.entry [data-action="project"]').click();
  const project = product.locator('.dialog.wide');
  await expect(project).toBeVisible();
  await expect(product.locator('.loc-row')).toHaveCount(8);
  const headerBefore = await project.locator('.dialog-head').boundingBox();
  await project.locator('.dialog-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const headerAfter = await project.locator('.dialog-head').boundingBox();
  expect(headerAfter?.y).toBeCloseTo(headerBefore?.y ?? -1, 0);
  const pathInput = product.locator('input[data-input^="location_"]').first();
  const pathBox = await pathInput.boundingBox();
  const projectBox = await project.boundingBox();
  expect((pathBox?.x ?? 0) + (pathBox?.width ?? 0))
    .toBeLessThanOrEqual((projectBox?.x ?? 0) + (projectBox?.width ?? 0) + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth) + 1);
  await page.keyboard.press('Escape');

  // Compact confirmation: Cancel is not a destructive action.
  await product.locator('.entry [data-action="delete"]').click();
  const confirm = product.locator('.dialog.compact');
  await expect(confirm).toBeVisible();
  await confirm.locator('.dialog-foot [data-action="close"]').click();
  await expect(product.locator('.dialog')).toHaveCount(0);
  await product.locator('.entry [data-action="delete"]').click();
  await product.locator('[data-action="confirm-delete"]').click();
  await expect(product.locator('[role="status"]')).toContainText('Project deletion confirmed');

  // Contextual menu and popover remain anchored and dismiss on Escape.
  await product.locator('.entry [data-action="menu"]').click();
  await product.locator('[data-action="open-actions"]').click();
  await expect(product.locator('[role="menu"]')).toBeVisible();
  await product.locator('[data-action="context:rename"]').click();
  await expect(product.locator('[role="status"]')).toContainText('rename action selected');
  await product.locator('.entry [data-action="menu"]').click();
  await product.locator('[data-action="open-popover"]').click();
  await expect(product.locator('.popup').last()).toBeVisible();
  await page.keyboard.press('Escape');

  // App: sheet → full-height settings → Back; full-height Session create keeps
  // its draft across the Location/Environment children.
  await page.locator('[data-np-size="390"][data-np-experience="app"]').click();
  await expect(product).toHaveAttribute('data-experience', 'app');
  await product.locator('.entry [data-action="attach"]').click();
  await expect(product.locator('.dialog.sheet')).toBeVisible();
  await product.locator('[data-action="settings"]').click();
  await expect(product.locator('.dialog.fullscreen')).toBeVisible();
  await product.locator('.dialog.fullscreen .dialog-head [data-action="back"]').click();
  await expect(product.locator('.dialog.sheet')).toBeVisible();
  await page.keyboard.press('Escape');

  await product.locator('.entry [data-action="session"]').click();
  const appSession = product.locator('.dialog.fullscreen');
  await expect(appSession).toBeVisible();
  await appSession.locator('[data-input="name"]').fill('draft-3142');
  await appSession.locator('[data-action="choose-location"]').click();
  await product.locator('[data-action="pick-beta"]').click();
  await expect(product.locator('[data-input="name"]')).toHaveValue('draft-3142');
  await product.locator('[data-action="choose-env"]').click();
  await product.locator('[data-action="env:.env.local"]').click();
  await product.locator('.dialog.fullscreen .dialog-head [data-action="back"]').click();
  await expect(product.locator('[data-input="name"]')).toHaveValue('draft-3142');
  await page.keyboard.press('Escape');

  // Switching back to Web keeps the selected Experience composition.
  await page.locator('[data-np-size="1180"][data-np-experience="web"]').click();
  await expect(product).toHaveAttribute('data-experience', 'web');
  await product.locator('.entry [data-action="project"]').click();
  await expect(product.locator('.dialog.wide')).toBeVisible();
  await page.keyboard.press('Escape');

  // Invalid and offline fixtures keep errors readable and the primary action
  // disabled.
  for (const fixture of ['invalid', 'offline']) {
    await page.locator(`[data-fixture="${fixture}"]`).click();
    await product.locator('.entry [data-action="session"]').click();
    const dialog = product.locator('.dialog.standard');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.error')).toBeVisible();
    await expect(dialog.locator('.dialog-foot .btn.primary')).toBeDisabled();
    await page.keyboard.press('Escape');
  }

  expect(pageErrors, 'the public mock must not throw').toEqual([]);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Chromium walked the live overlay mock at Web 1440/1180 and App ' +
      '390: standard/wide/compact/sheet/fullscreen roles, anchored child-first Escape, long ' +
      'fixture body scroll with stable header, explicit delete, App settings Back and Session ' +
      'draft across child depths, Web↔App switching, and invalid/offline disabled actions. ' +
      'Prototype mock evidence only',
  });
});
