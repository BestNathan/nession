// #3136 SC-01: one same-row rule for the Web Project Existing Location fields.
// Agent and Directory labels/field tops align on the Experience control band;
// the single-line Agent control and the compact Directory start at the same
// baseline; a long wrapped path grows the Directory downward without moving
// Agent or the Remove action, and the dialog keeps one intended scroll owner.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock, waitForFixtureTerminal } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function tokenPx(page: Page, variable: string): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;min-height:var(${name})`;
    const scope =
      document.querySelector('[data-experience="app"]') ?? document.body;
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
      ? Math.round(second.height)
      : -1;
  }).toBeGreaterThan(0);
  return (await locator.boundingBox())!;
}

async function noPageOverflow(page: Page): Promise<void> {
  const { scrollWidth, width } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(width + 1);
}

async function openCreateDialog(page: Page) {
  await page.goto('/#/fixture?projects=canonical');
  await waitForFixtureTerminal(page);
  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('SC-01: Web Existing Location fields share top-aligned compact geometry', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    const dialog = await openCreateDialog(page);
    await dialog.getByTestId('project-location-add').click();

    const agent = page.locator('#project-create-location-agent-0');
    const path = page.locator('#project-create-location-path-0');
    const agentLabel = page.locator('label[for="project-create-location-agent-0"]');
    const pathLabel = page.locator('label[for="project-create-location-path-0"]');
    const remove = page.getByTestId('project-location-remove-0');
    const row = page.getByTestId('project-location-editor').first();
    const band = await tokenPx(page, '--nession-control-md');
    expect(band).toBe(32);

    await expect(agent).toHaveAttribute('data-size', 'field');
    await expect(path).toHaveAttribute('data-variant', 'field');
    await expect(path).toHaveAttribute('rows', '1');

    await path.fill('/srv/nession');
    await page.waitForTimeout(120);
    const shortAgent = await settledBox(page, agent);
    const shortPath = await settledBox(page, path);
    const labelAgent = await settledBox(page, agentLabel);
    const labelPath = await settledBox(page, pathLabel);
    const shortRemove = await settledBox(page, remove);
    const shortRow = await settledBox(page, row);
    const shortAgentOffset = shortAgent.y - shortRow.y;
    expect(labelAgent.y).toBeCloseTo(labelPath.y, 0);
    expect(shortAgent.y).toBeCloseTo(shortPath.y, 0);
    expect(shortAgent.height).toBe(band);
    expect(shortPath.height).toBe(band);
    expect(shortRemove.y).toBeCloseTo(shortAgent.y, 0);
    expect(shortRemove.height).toBe(band);
    expect(await row.evaluate((element) => getComputedStyle(element).alignItems))
      .toBe('flex-start');

    const longPath =
      '/Users/nathan/code/nession/.claude/worktrees/fix-3136-location-row/web/src/product/project/components/very-long-directory-name';
    await path.fill(longPath);
    await page.waitForTimeout(150);
    const longAgent = await settledBox(page, agent);
    const longPathBox = await settledBox(page, path);
    const longRemove = await settledBox(page, remove);
    const longRow = await settledBox(page, row);
    expect(longPathBox.height).toBeGreaterThan(band);
    // The dialog may scroll as the Directory grows; the Agent keeps its
    // offset inside the row instead of being dragged to the Directory bottom.
    expect(longAgent.y - longRow.y).toBeCloseTo(shortAgentOffset, 0);
    expect(longPathBox.y).toBeCloseTo(longAgent.y, 0);
    expect(longRemove.y).toBeCloseTo(longAgent.y, 0);
    await expect(path).toHaveValue(longPath);
    expect(await path.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
      .toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1))
      .toBe(true);
    await noPageOverflow(page);
    observed.push(
      `${viewport.width}x${viewport.height}: labels y=${Math.round(labelAgent.y)}, fields y=${Math.round(longAgent.y)}, agent ${Math.round(longAgent.height)}px, directory ${Math.round(shortPath.height)}→${Math.round(longPathBox.height)}px`,
    );

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | ') +
      '; Agent and Directory labels/tops aligned on the 32px band, the wrapped path grew only the Directory, and Remove stayed on the field top',
  });
});

test('SC-01: many grown rows keep the dialog as the single scroll owner', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  const dialog = await openCreateDialog(page);
  await dialog.getByTestId('project-location-add').click();
  const longPath =
    '/Users/nathan/code/nession/.claude/worktrees/fix-3136-location-row/web/src/product/project/components/very-long-directory-name';
  await page.locator('#project-create-location-path-0').fill(longPath);
  for (let index = 1; index < 8; index += 1) {
    await dialog.getByTestId('project-location-add').click();
    await page.locator(`#project-create-location-path-${index}`).fill(longPath);
  }
  await expect(page.getByTestId('project-location-editor')).toHaveCount(8);
  await expect.poll(async () =>
    dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(
    await dialog.locator('form').evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe('visible');
  await noPageOverflow(page);
  const firstPath = page.locator('#project-create-location-path-0');
  expect(await firstPath.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
    .toBe(true);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': eight wrapped Directory rows grew inside the dialog body, the dialog ' +
      'was the only vertical scroll owner, each field kept its full content and no page or dialog ' +
      'horizontal overflow appeared at 1024x600',
  });
});
