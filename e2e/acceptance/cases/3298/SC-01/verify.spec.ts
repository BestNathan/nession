// #3298 SC-01: production Web dialogs have one three-zone shell. The Header is
// a full-width opaque band that covers the close control and stays fixed while
// DialogBody alone scrolls; no content bleeds above it, no second form scroller
// appears and the page never overflows horizontally. Short dialogs keep the
// same header/body/footer order without forcing a scroll.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function settledBox(locator: Locator) {
  let previous = await locator.boundingBox();
  expect(previous).not.toBeNull();
  await expect
    .poll(async () => {
      await locator.page().waitForTimeout(60);
      const next = await locator.boundingBox();
      if (!next || !previous) return false;
      const stable =
        Math.abs(next.x - previous.x) < 0.5 &&
        Math.abs(next.y - previous.y) < 0.5 &&
        Math.abs(next.width - previous.width) < 0.5 &&
        Math.abs(next.height - previous.height) < 0.5;
      previous = next;
      return stable;
    })
    .toBe(true);
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

async function addLocations(page: Page, dialog: Locator, count: number): Promise<void> {
  const add = dialog.getByTestId('project-location-add');
  for (let index = 0; index < count; index += 1) {
    const before = await page.locator('[id^="project-create-location-agent-"]').count();
    await add.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.locator('[id^="project-create-location-agent-"]').count())
      .toBe(before + 1);
  }
}

async function expectNoPageOverflow(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width + 1);
}

test('SC-01: overflowed Web dialogs keep a fixed full-width header and one body scroll', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 700 },
    { width: 1024, height: 700 },
    { width: 900, height: 420 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture?experience=web&projects=canonical');
    await page.getByTestId('project-item-row').first().waitFor();
    await page.getByTestId('project-create').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await addLocations(page, dialog, 8);

    const header = dialog.locator('[data-slot="dialog-header"]');
    const body = dialog.locator('[data-slot="dialog-body"]');
    const footer = dialog.locator('[data-slot="dialog-footer"]');
    const close = dialog.locator('[data-slot="dialog-close"]');
    const form = dialog.locator('form');
    const dialogBox = await settledBox(dialog);
    const headerBox = await settledBox(header);
    const bodyBox = await settledBox(body);
    const footerBox = await settledBox(footer);
    const closeBox = await settledBox(close);

    // The Header is the surface's top band: full width, at the top edge, opaque.
    expect(headerBox.x).toBeCloseTo(dialogBox.x, 0);
    expect(headerBox.width).toBeCloseTo(dialogBox.width, 0);
    expect(headerBox.y).toBeCloseTo(dialogBox.y, 0);
    expect(headerBox.height).toBeGreaterThan(closeBox.height);
    expect(await backgroundAlpha(header)).toBe(1);
    // The close control is inside that band, not in the scrolling content.
    expect(closeBox.y).toBeGreaterThanOrEqual(headerBox.y - 0.5);
    expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(
      headerBox.y + headerBox.height + 0.5,
    );

    // The dialog is not a scroll container; the Body is the sole one.
    expect(
      await dialog.evaluate((element) => getComputedStyle(element).overflowY),
    ).toBe('hidden');
    expect(
      await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    ).toBe(true);
    expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
    expect(
      await body.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    expect(
      await form.evaluate((element) =>
        getComputedStyle(element).overflowY === 'visible' &&
        element.scrollHeight <= element.clientHeight + 1),
      'the form wrapper is not a second scroller',
    ).toBe(true);
    // No bleed above the Header or below the Body.
    expect(bodyBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
    expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(footerBox.y + 0.5);

    for (const position of ['start', 'middle', 'end'] as const) {
      await body.evaluate((element, where) => {
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = where === 'start' ? 0 : where === 'middle' ? max / 2 : max;
      }, position);
      await page.waitForTimeout(80);
      const scrolledHeader = await settledBox(header);
      const scrolledClose = await settledBox(close);
      expect(scrolledHeader.x).toBeCloseTo(headerBox.x, 0);
      expect(scrolledHeader.y).toBeCloseTo(headerBox.y, 0);
      expect(scrolledHeader.width).toBeCloseTo(headerBox.width, 0);
      expect(scrolledHeader.height).toBeCloseTo(headerBox.height, 0);
      expect(scrolledClose.y).toBeCloseTo(closeBox.y, 0);
      expect(await backgroundAlpha(header)).toBe(1);
      const scrolledBody = await settledBox(body);
      expect(scrolledBody.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
      await expectNoPageOverflow(page, viewport.width);
    }

    observed.push(
      `${viewport.width}x${viewport.height}: header ${Math.round(headerBox.width)}x${Math.round(headerBox.height)} at top, close covered, dialog overflow hidden, body ${Math.round(bodyBox.height)}px scroll owner`,
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join(' | ') +
      '; header/close geometry stayed identical at body scroll start/middle/end',
  });
});

test('SC-01: a short Web dialog keeps the ordered bands without a forced scroll', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().waitFor();
  const projectId = await page.getByTestId('project-item-row').first().getAttribute('data-project-id');
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await expect(dialog).toBeVisible();

  const header = dialog.locator('[data-slot="dialog-header"]');
  const body = dialog.locator('[data-slot="dialog-body"]');
  const footer = dialog.locator('[data-slot="dialog-footer"]');
  const dialogBox = await settledBox(dialog);
  const headerBox = await settledBox(header);
  const bodyBox = await settledBox(body);
  const footerBox = await settledBox(footer);

  expect(dialogBox.height).toBeLessThan(900);
  expect(headerBox.x).toBeCloseTo(dialogBox.x, 0);
  expect(headerBox.width).toBeCloseTo(dialogBox.width, 0);
  expect(headerBox.y).toBeCloseTo(dialogBox.y, 0);
  expect(bodyBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(footerBox.y + 0.5);
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
  expect(
    await body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  expect(
    await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  expect(await backgroundAlpha(header)).toBe(1);
  expect(await backgroundAlpha(footer)).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the short Rename Project dialog stayed ' +
      Math.round(dialogBox.width) + 'x' + Math.round(dialogBox.height) +
      ' with Header/Body/Footer in order, no surface scroll and opaque bands',
  });
});
