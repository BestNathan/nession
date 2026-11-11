// #3298 SC-02: production Footer is an opaque, full-width band flush with the
// surface bottom within 1 CSS px in short and overflowing dialogs. The body
// ends exactly at the Footer band (no blank strip or field underpaint), the
// action controls remain inside it, and submit/cancel/error/Enter semantics are
// preserved by the one-form composition.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function settledBox(locator: Locator) {
  let previous = await locator.boundingBox();
  expect(previous).not.toBeNull();
  await expect.poll(async () => {
    await locator.page().waitForTimeout(60);
    const next = await locator.boundingBox();
    if (!next || !previous) return false;
    const stable = Math.abs(next.x - previous.x) < 0.5 &&
      Math.abs(next.y - previous.y) < 0.5 &&
      Math.abs(next.width - previous.width) < 0.5 &&
      Math.abs(next.height - previous.height) < 0.5;
    previous = next;
    return stable;
  }).toBe(true);
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
    await expect.poll(() => page.locator('[id^="project-create-location-agent-"]').count())
      .toBe(before + 1);
  }
}

async function expectFooterBand(
  page: Page,
  dialog: Locator,
  action: Locator,
): Promise<void> {
  const footer = dialog.locator('[data-slot="dialog-footer"]');
  const body = dialog.locator('[data-slot="dialog-body"]');
  const dialogBox = await settledBox(dialog);
  const footerBox = await settledBox(footer);
  const bodyBox = await settledBox(body);
  const actionBox = await action.boundingBox();
  expect(actionBox).not.toBeNull();

  expect(footerBox.x).toBeCloseTo(dialogBox.x, 0);
  expect(footerBox.width).toBeCloseTo(dialogBox.width, 0);
  // ≤1 CSS px geometry deviation at the real surface bottom.
  expect(Math.abs(footerBox.y + footerBox.height - (dialogBox.y + dialogBox.height)))
    .toBeLessThanOrEqual(1);
  // The body ends at the Footer band: no blank strip and no field underneath.
  expect(Math.abs(bodyBox.y + bodyBox.height - footerBox.y)).toBeLessThanOrEqual(1);
  expect(await backgroundAlpha(footer)).toBe(1);
  expect(actionBox!.y).toBeGreaterThanOrEqual(footerBox.y - 0.5);
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(
    footerBox.y + footerBox.height + 0.5,
  );
  expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(
    dialogBox.x + dialogBox.width + 0.5,
  );
  expect(
    await dialog.evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe('hidden');
  expect(
    await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

test('SC-02: the Footer is opaque and flush in overflowing and short dialogs', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
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
    await expectFooterBand(page, dialog, dialog.getByTestId('project-create-submit'));

    // Scrolling the Body does not move the Footer or reveal a gap below it.
    const footer = dialog.locator('[data-slot="dialog-footer"]');
    const footerBox = await settledBox(footer);
    const body = dialog.locator('[data-slot="dialog-body"]');
    for (const where of ['middle', 'end'] as const) {
      await body.evaluate((element, position) => {
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = position === 'middle' ? max / 2 : max;
      }, where);
      await page.waitForTimeout(80);
      const scrolled = await settledBox(footer);
      expect(scrolled.y).toBeCloseTo(footerBox.y, 0);
      expect(await backgroundAlpha(footer)).toBe(1);
      const dialogBox = await settledBox(dialog);
      expect(Math.abs(scrolled.y + scrolled.height - (dialogBox.y + dialogBox.height)))
        .toBeLessThanOrEqual(1);
    }
    observed.push(
      `${viewport.width}x${viewport.height}: footer full width, flush ≤1px, opaque, actions inside`,
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  // Short dialog: same band, flush with the natural-height surface.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().waitFor();
  const projectId = await page.getByTestId('project-item-row').first().getAttribute('data-project-id');
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const rename = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await expect(rename).toBeVisible();
  await expectFooterBand(page, rename, rename.getByTestId('project-rename-submit'));
  observed.push('Rename short dialog: same opaque flush footer');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | '),
  });
});

test('SC-02: one form keeps Enter, validation, cancel and action ownership', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().waitFor();
  const projectId = await page.getByTestId('project-item-row').first().getAttribute('data-project-id');

  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await expect(dialog).toBeVisible();
  const input = dialog.locator('#project-rename-name');
  await expect(input).toBeFocused();
  await input.fill('');
  await input.press('Enter');
  await expect(dialog).toBeVisible();
  const error = dialog.getByText('Project name is required');
  await expect(error).toBeVisible();
  const body = dialog.locator('[data-slot="dialog-body"]');
  await expect(body).toContainText('Project name is required');
  await expectFooterBand(page, dialog, dialog.getByTestId('project-rename-submit'));

  await input.fill('Renamed by SC-02');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('project-item-row').filter({ hasText: 'Renamed by SC-02' }))
    .toHaveCount(1);

  // Cancel leaves the persisted name intact and never submits.
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const second = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await expect(second).toBeVisible();
  await second.locator('#project-rename-name').fill('Should not persist');
  await second.getByRole('button', { name: 'Cancel' }).click();
  await expect(second).toHaveCount(0);
  await expect(page.getByTestId('project-item-row').filter({ hasText: 'Renamed by SC-02' }))
    .toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Enter submitted the one form, empty name kept the dialog with ' +
      'an in-Body validation error, a valid rename closed it, and Cancel changed nothing',
  });
});
