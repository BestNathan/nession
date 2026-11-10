// #3136 SC-03: a real Chromium walkthrough of the published #3089 mock revision
// — Web short/long Existing Location rows, the App stacked variant, and the
// offline fixture. This is prototype evidence, not production Acceptance.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/session-operation-surfaces-3089/index.html';
const LONG_PATH =
  '/srv/workspaces/nession/infrastructure/experiments/agent-workspaces/very-long-nested-source-root/feature-branches/session-runtime';

function box(locator: Locator) {
  return locator.boundingBox();
}

async function openProjectDraft(page: Page): Promise<Locator> {
  const product = page.locator('#nession-product');
  await product.locator('[data-act="project-create"]').first().click();
  await product.locator('[data-act="add-location"]').click();
  const row = product.locator('[data-location-editor="0"]');
  await expect(row).toBeVisible();
  return row;
}

test('SC-03: the revised mock keeps the Project Location row rule', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  const product = page.locator('#nession-product');
  await expect(product).toBeVisible();
  await expect(product).toHaveAttribute('data-experience', 'web');

  const row = await openProjectDraft(page);
  const agentLabel = row.locator('.field').nth(0).locator('.label');
  const pathLabel = row.locator('.field').nth(1).locator('.label');
  const agent = row.locator('select');
  const path = row.locator('textarea');
  const remove = row.locator('[data-act="remove-location"]');
  await path.fill('/srv/nession');
  await page.waitForTimeout(150);

  const labelsAligned = Math.abs((await box(agentLabel))!.y - (await box(pathLabel))!.y) < 0.5;
  expect(labelsAligned).toBe(true);
  const shortAgent = await box(agent);
  const shortPath = await box(path);
  const shortRemove = await box(remove);
  const shortRow = await row.boundingBox();
  const shortAgentOffset = shortAgent!.y - shortRow!.y;
  expect(shortAgent!.height).toBe(32);
  expect(shortPath!.height).toBe(32);
  expect(Math.abs(shortAgent!.y - shortPath!.y)).toBeLessThan(0.5);
  expect(Math.abs(shortRemove!.y - shortAgent!.y)).toBeLessThan(0.5);
  expect(shortRemove!.height).toBe(32);
  expect(await product.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);

  await path.fill(LONG_PATH);
  await page.waitForTimeout(150);
  const longAgent = await box(agent);
  const longPath = await box(path);
  const longRow = await row.boundingBox();
  expect(longPath!.height).toBeGreaterThan(32);
  // The mock page may scroll as the Directory grows; compare the Agent's
  // offset inside the row, not its viewport y.
  expect(Math.abs(longAgent!.y - longRow!.y - shortAgentOffset)).toBeLessThan(0.5);
  expect(Math.abs(longPath!.y - longAgent!.y)).toBeLessThan(0.5);
  expect(Math.abs((await box(remove))!.y - longAgent!.y)).toBeLessThan(0.5);
  await expect(path).toHaveValue(LONG_PATH);
  expect(await product.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await page.screenshot({ path: '/tmp/choice-3136-web.png' });

  // App: the same rule in the stacked full-width composition.
  await page.reload();
  await product.waitFor();
  await page.locator('[data-np-size="390"][data-np-experience="app"]').click();
  await expect(product).toHaveAttribute('data-experience', 'app');
  const appRow = await openProjectDraft(page);
  const appAgent = appRow.locator('select');
  const appPath = appRow.locator('textarea');
  const appRemove = appRow.locator('[data-act="remove-location"]');
  const appAgentShort = await box(appAgent);
  const appPathShort = await box(appPath);
  const appRemoveBox = await box(appRemove);
  expect(appAgentShort!.height).toBe(44);
  expect(appPathShort!.height).toBe(44);
  expect(appAgentShort!.width).toBe(appPathShort!.width);
  expect(appAgentShort!.width).toBeGreaterThan(300);
  expect(appRemoveBox!.height).toBe(44);
  await appPath.fill(LONG_PATH);
  await page.waitForTimeout(150);
  const appPathLong = await box(appPath);
  expect(appPathLong!.height).toBeGreaterThan(44);
  expect((await box(appAgent))!.height).toBe(44);
  expect(await product.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await page.screenshot({ path: '/tmp/choice-3136-app.png' });

  // Offline fixture remains an honest representative state on the Project
  // detail the form edits.
  await page.reload();
  await expect(product).toBeVisible();
  await page.locator('[data-fixture="offline"]').click();
  await expect(page.locator('[data-fixture="offline"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(product.getByText('Offline', { exact: true }).first()).toBeVisible();

  expect(pageErrors, 'the public mock must not throw').toEqual([]);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Chromium walked the live mock at Web 1440 and App 390 — Agent and ' +
      'Directory labels/tops aligned on 32px Web / 44px App, a long path grew only the Directory, ' +
      'Remove stayed on the field top (32px Web, 44px App), the App fields were full-width, and ' +
      'the offline fixture remained visible with no page errors',
  });
});
