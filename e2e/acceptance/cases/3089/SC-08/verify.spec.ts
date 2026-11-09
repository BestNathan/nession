// #3089 SC-08 browser half: a real Chromium click-through of the published
// public preview. It exercises the revised content-sized Location dropdown and
// the source-aligned Web/App Env anatomy. This is prototype mock evidence, not
// production Acceptance.
import { expect, test } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/session-operation-surfaces-3089/index.html';
const LONG_PATH_MARKER = 'very-long-nested-source-root';

async function box(locator: import('@playwright/test').Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

function inside(child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number }) {
  expect(child.x).toBeGreaterThanOrEqual(parent.x - 0.5);
  expect(child.x + child.width).toBeLessThanOrEqual(parent.x + parent.width + 0.5);
  expect(child.y).toBeGreaterThanOrEqual(parent.y - 0.5);
  expect(child.y + child.height).toBeLessThanOrEqual(parent.y + parent.height + 0.5);
}

test('SC-08: the public preview operates the content-sized Select and Env anatomy', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-08');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(PROTOTYPE_URL);
  const product = page.locator('#nession-product');
  await expect(product).toBeVisible();
  await page.locator('[data-fixture="long"]').click();

  // Web Project → New Session: the selected trigger contains Agent, the
  // wrapped long path and status; the menu overlays without shifting fields.
  await product.locator('[data-act="create-project-session"]').click();
  const dialog = page.locator('.web-dialog[role="dialog"]');
  await expect(dialog).toBeVisible();
  const trigger = dialog.locator('[data-location-trigger]');
  const triggerBox = await box(trigger);
  expect(triggerBox.height).toBeGreaterThan(60);
  expect(await trigger.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  const path = trigger.locator('.location-path');
  await expect(path).toContainText(LONG_PATH_MARKER);
  inside(await box(trigger.locator('.location-agent')), triggerBox);
  inside(await box(path), triggerBox);
  inside(await box(trigger.locator('.location-status')), triggerBox);

  const sessionName = dialog.locator('[name="sessionName"]');
  const nameBefore = await box(sessionName);
  await trigger.click();
  const options = dialog.locator('[data-location-option]');
  await expect(options).toHaveCount(2);
  const menu = dialog.locator('.location-options');
  const menuBox = await box(menu);
  expect(menuBox.width).toBeCloseTo(triggerBox.width, 0);
  inside(await box(options.first().locator('.location-path')), await box(options.first()));
  inside(await box(options.nth(1).locator('.location-path')), await box(options.nth(1)));
  for (const option of await options.all()) {
    await expect(option).not.toContainText('Agent online');
    await expect(option).not.toContainText('Agent offline');
  }
  // The menu overlays: opening it does not push the next field down.
  expect((await box(sessionName)).y).toBeCloseTo(nameBefore.y, 0);

  await options.nth(1).click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toContainText('Test Agent');
  await expect(trigger).toContainText('Agent online');
  inside(await box(trigger.locator('.location-path')), await box(trigger));

  // Web EnvFileMultiSelect anatomy: 32px search, 224px scrolling list, 16px
  // checks, source badge, var count, selected count and working search.
  const env = dialog.locator('[data-env-multi]');
  const search = env.locator('input[name="envQuery"]');
  expect((await box(search)).height).toBe(32);
  expect((await box(env.locator('.env-file-list'))).height).toBe(224);
  const checkBox = env.locator('.env-check-box').first();
  expect((await box(checkBox)).width).toBe(16);
  expect((await box(checkBox)).height).toBe(16);
  await expect(env.locator('.env-source-badge').first()).not.toBeEmpty();
  await expect(env.locator('.env-var-count').first()).toContainText('var');
  await expect(env.locator('.env-selected-count')).toContainText('selected');
  await search.fill('test');
  await expect(env.locator('.env-file-row')).toHaveCount(1);
  await env.locator('.env-file-row').click();
  await expect(env.locator('.env-selected-count')).toContainText('selected');

  // New Project Agent/Directory: the ordinary one-line control is 42px and
  // the textarea grows only when its own content wraps.
  await dialog.locator('[data-act="cancel"]').click();
  await expect(dialog).toHaveCount(0);
  await product.locator('[data-act="project-create"]').click();
  const projectDialog = page.locator('.web-dialog[role="dialog"][aria-label="New Project"]');
  await expect(projectDialog).toBeVisible();
  await projectDialog.locator('[data-act="add-location"]').click();
  const editor = projectDialog.locator('[data-location-editor="0"]');
  const agent = editor.locator('select');
  const directory = editor.locator('textarea.project-path-input');
  expect((await box(agent)).height).toBe(42);
  expect((await box(directory)).height).toBe(42);
  const agentBox = await box(agent);
  const directoryBox = await box(directory);
  expect(Math.abs(agentBox.y - directoryBox.y)).toBeLessThanOrEqual(1);
  await directory.fill(
    '/srv/workspaces/nession/infrastructure/experiments/agent-workspaces/very-long-nested-source-root/feature-branches',
  );
  const grown = await box(directory);
  expect(grown.height).toBeGreaterThan(42);
  expect(grown.height).toBeLessThanOrEqual(160);
  const formBox = await box(projectDialog.locator('[data-form="new-project"]'));
  inside(agentBox, formBox);
  inside(grown, formBox);

  // App keeps a separate full-depth Env page: search plus an unscrolled list,
  // not the Web dialog's nested fixed-height box.
  await page.locator('[data-np-size="390"][data-np-experience="app"]').click();
  await expect(product).toHaveAttribute('data-experience', 'app');
  await product.locator('[data-act="create-project-session"]').click();
  await product.locator('[data-act="choose-env"]').click();
  const appEnv = product.locator('.app-operation [data-env-multi]');
  await expect(appEnv).toBeVisible();
  expect((await box(appEnv.locator('input[name="envQuery"]'))).height).toBe(32);
  const appList = appEnv.locator('.env-file-list');
  await expect(appList).toHaveClass(/env-unscrolled/);
  expect((await box(appEnv.locator('.env-check-box').first())).width).toBe(16);

  expect(pageErrors, 'the public mock must not throw').toEqual([]);
  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Chromium operated the live ' + PROTOTYPE_URL + '; Web long-path ' +
      'trigger contained Agent/path/status, options wrapped without status, the menu overlaid the ' +
      'form; Web Env measured 32/224/16 with source badges and working search; New Project ' +
      'Agent/Directory was 42/42 and the Directory grew for a long path; App Env was a full-depth ' +
      'search list without the Web nested scroll. Prototype mock evidence only',
  });
});
