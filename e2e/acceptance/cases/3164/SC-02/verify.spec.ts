// #3164 SC-02: production resource-choice geometry. A rich Select row carries
// the full resource identity plus quiet metadata/status, wraps instead of
// clipping, and keeps the Experience control band as its floor. The anchored
// list never gets narrower than its trigger; simple action lists keep their
// single-line 28px Web / 44px App contract.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock, waitForFixtureTerminal } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function tokenPx(page: Page, variable: string): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;min-height:var(${name})`;
    const scope =
      document.querySelector('[data-testid="app-popup-portal"]') ?? document.body;
    scope.append(probe);
    const value = parseFloat(getComputedStyle(probe).minHeight);
    probe.remove();
    return value;
  }, variable);
}

async function settledBox(page: Page, locator: Locator) {
  await expect.poll(async () => {
    const first = await locator.boundingBox();
    await page.waitForTimeout(60);
    const second = await locator.boundingBox();
    return first && second && Math.abs(first.width - second.width) < 0.5 &&
      Math.abs(first.height - second.height) < 0.5
      ? Math.round(second.width)
      : -1;
  }).toBeGreaterThan(0);
  return (await locator.boundingBox())!;
}

async function backgroundAlpha(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const color = getComputedStyle(element).backgroundColor;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2d canvas is unavailable');
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] / 255;
  });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const { scrollWidth, width } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(width + 1);
}

async function expectResourceRow(
  page: Page,
  item: Locator,
  band: number,
  { status, selected = false }: { status?: string; selected?: boolean } = {},
): Promise<void> {
  await expect(item).toHaveAttribute('data-anatomy', 'resource');
  await expect(item.locator('[data-slot="choice-item-title"]')).toBeVisible();
  const box = await settledBox(page, item);
  expect(box.height).toBeGreaterThanOrEqual(band - 0.5);
  if (status) {
    await expect(item.locator('[data-slot="choice-item-status"]')).toHaveText(status);
  }
  if (selected) {
    const indicator = item.locator('[data-slot="select-item-indicator"]');
    await expect(indicator).toBeVisible();
    const indicatorBox = await indicator.boundingBox();
    expect(indicatorBox).not.toBeNull();
    expect(indicatorBox!.x + indicatorBox!.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    expect(Math.abs(indicatorBox!.y + indicatorBox!.height / 2 - (box.y + box.height / 2)))
      .toBeLessThanOrEqual(1);
  }
}

test('SC-02: Web resource choices keep identity, metadata and one list scroll', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 700 },
    { width: 1024, height: 700 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture?projects=canonical');
    await waitForFixtureTerminal(page);
    await page.getByTestId('project-create').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('project-location-add').click();
    const trigger = page.locator('#project-create-location-agent-0');
    await trigger.click();
    const list = page.locator('[role="listbox"]:visible');
    await expect(list).toBeVisible();
    const items = list.getByRole('option');
    await expect(items).toHaveCount(3);
    const band = await tokenPx(page, '--nession-control-sm');
    expect(band).toBe(28);

    const listBox = await settledBox(page, list);
    const triggerBox = await settledBox(page, trigger);
    expect(listBox.width).toBeGreaterThanOrEqual(triggerBox.width - 1);
    expect(listBox.x).toBeGreaterThanOrEqual(-0.5);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true);

    for (let index = 0; index < 3; index += 1) {
      await expectResourceRow(page, items.nth(index), band, { selected: index === 0 });
    }
    await expect(items.first()).toHaveAttribute('data-selected', '');
    expect(await backgroundAlpha(items.first())).toBeGreaterThan(0.5);
    await expectNoPageOverflow(page);
    observed.push(`${viewport.width}x${viewport.height}: list ${Math.round(listBox.width)}px ≥ trigger ${Math.round(triggerBox.width)}px, rows ≥ ${band}px`);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | ') +
      '; Agent rows kept title+status, a stable aligned check and no horizontal overflow',
  });
});

test('SC-02: a long Existing Location keeps its full path and action lists keep the band', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=long');
  await page.reload();
  await waitForFixtureTerminal(page);
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByTestId('create-session-dialog');
  await expect(dialog).toBeVisible();
  const trigger = page.getByTestId('project-location-trigger');
  await trigger.click();
  const list = page.locator('[role="listbox"]:visible');
  await expect(list).toBeVisible();
  const items = list.getByRole('option');
  await expect(items).toHaveCount(2);
  const band = await tokenPx(page, '--nession-control-sm');
  const longPath = '/Users/nathan/code/nession/.claude/worktrees/fix-3089-select-location-geometry/web/src/product/session/components';

  const listBox = await settledBox(page, list);
  const triggerBox = await settledBox(page, trigger);
  expect(listBox.width).toBeGreaterThanOrEqual(triggerBox.width - 1);
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await expect(items.first()).toContainText('Agent online');
  await expect(items.first().locator('[data-slot="choice-item-detail"]')).toHaveText(longPath);
  const firstRow = await settledBox(page, items.first());
  expect(firstRow.height).toBeGreaterThan(band);
  await expectResourceRow(page, items.first(), band, { status: 'Agent online', selected: true });

  // Moving focus must not erase the selected row's quiet surface.
  await expect(items.first()).toHaveAttribute('data-selected', '');
  await page.keyboard.press('ArrowDown');
  expect(await items.first().getAttribute('data-selected')).toBe('');
  expect(await backgroundAlpha(items.first())).toBeGreaterThan(0.5);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);

  // One Env example: the Agent picker in Import is a resource list, while the
  // Location picker beside it stays a simple action list at the 28px band.
  await page.goto('/#/fixture/workspace?capability=env');
  await page.getByTestId('env-profile-list').waitFor();
  await page.getByTestId('env-new-menu').click();
  await page.getByTestId('env-import').click();
  await expect(page.getByTestId('env-import-dialog')).toBeVisible();
  await page.getByTestId('env-import-location').click();
  const locationList = page.locator('[role="listbox"]:visible');
  const locationOptions = locationList.getByRole('option');
  await expect(locationOptions.first()).toBeVisible();
  await expect(locationOptions.first()).toHaveAttribute('data-anatomy', 'action');
  expect((await settledBox(page, locationOptions.first())).height).toBe(band);
  expect(
    await locationOptions
      .first()
      .locator('[data-slot="select-item-text"]')
      .evaluate((element) => getComputedStyle(element).whiteSpace),
  ).toBe('nowrap');
  await page.keyboard.press('Escape');
  await expect(locationOptions).toHaveCount(0);
  await page.getByTestId('env-import-location').click();
  await page.getByRole('option', { name: 'Agent', exact: true }).click();
  await expect(locationOptions).toHaveCount(0);
  await page.getByTestId('env-import-agent').click();
  const envList = page.locator('[role="listbox"]:visible');
  const agentOptions = envList.getByRole('option');
  await expect(agentOptions.first()).toBeVisible();
  const envTrigger = page.getByTestId('env-import-agent');
  const envListBox = await settledBox(page, envList);
  const envTriggerBox = await settledBox(page, envTrigger);
  expect(envListBox.width).toBeGreaterThanOrEqual(envTriggerBox.width - 1);
  await expectResourceRow(page, agentOptions.first(), band);
  expect(await envList.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
    .toBe(true);
  await expectNoPageOverflow(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the long Existing Location rendered its full path and Agent status ' +
      'inside a 64px resource row with one scroll axis, kept its selected surface after focus ' +
      'moved, and the Env Import Location/Agent lists kept action 28px vs resource anatomy',
  });
});

test('SC-02: App resource choices keep the 44px touch band inside the dialog', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed: string[] = [];

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture/app?projects=canonical');
    await page.reload();
    await page.getByTestId('app-layer-root').waitFor();
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page.getByTestId('project-create').click();
    const pageSurface = page.getByTestId('app-project-create-page');
    await expect(pageSurface).toBeVisible();
    await page.getByTestId('project-location-add').click();
    const trigger = page.locator('#project-create-location-agent-0');
    await trigger.click();
    const list = page.locator('[role="listbox"]:visible');
    await expect(list).toBeVisible();
    const items = list.getByRole('option');
    await expect(items).toHaveCount(3);
    const band = await tokenPx(page, '--nession-control-sm');
    expect(band).toBe(44);

    const listBox = await settledBox(page, list);
    const triggerBox = await settledBox(page, trigger);
    expect(listBox.width).toBeGreaterThanOrEqual(triggerBox.width - 1);
    expect(listBox.x).toBeGreaterThanOrEqual(-0.5);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    for (let index = 0; index < 3; index += 1) {
      await expectResourceRow(page, items.nth(index), band, { selected: index === 0 });
      expect((await settledBox(page, items.nth(index))).height).toBe(band);
    }
    expect(await list.evaluate((element) => element.closest('[data-experience="app"]') !== null))
      .toBe(true);
    const dialogBox = await settledBox(page, pageSurface);
    expect(listBox.height).toBeLessThan(dialogBox.height);
    await expectNoPageOverflow(page);
    observed.push(`${viewport.width}x${viewport.height}: list ${Math.round(listBox.width)}px, rows ${band}px`);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(pageSurface).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pageSurface).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | ') +
      '; every App resource row measured the 44px band, stayed inside the viewport and dialog, and remained in the App popup scope',
  });
});

test('SC-02: a large Agent fleet scrolls inside the available height', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 500 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture?agents=many&projects=canonical');
    await page.reload();
    await waitForFixtureTerminal(page);
    await page.getByTestId('project-create').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('project-location-add').click();
    const trigger = page.locator('#project-create-location-agent-0');
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const list = page.locator('[role="listbox"]:visible');
    await expect(list).toBeVisible();
    const items = list.getByRole('option');
    await expect(items).toHaveCount(23);
    const band = await tokenPx(page, '--nession-control-sm');
    const listBox = await settledBox(page, list);
    expect(listBox.y).toBeGreaterThanOrEqual(-0.5);
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await page.keyboard.press('End');
    await expect(items.last()).toHaveAttribute('data-highlighted', '');
    await items.last().scrollIntoViewIfNeeded();
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const scrolledBox = await settledBox(page, list);
    expect(scrolledBox.y).toBeGreaterThanOrEqual(-0.5);
    expect(scrolledBox.y + scrolledBox.height).toBeLessThanOrEqual(viewport.height + 0.5);
    await expectNoPageOverflow(page);
    observed.push(`${viewport.width}x${viewport.height}: 23 rows, list ${Math.round(scrolledBox.width)}x${Math.round(scrolledBox.height)} scrolls`);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | ') +
      '; End reached the last Agent and the bounded list stayed inside the viewport',
  });
});
