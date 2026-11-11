// #3128 SC-01 (maintained under the #3298 three-zone contract): a scrolling Web
// dialog keeps its action footer as a fixed opaque band flush with the dialog's
// bottom edge while DialogBody alone scrolls. The action stays inside the band.
// Short dialogs use the same opaque band; the old in-flow translucent variant
// is retired by the shared anatomy.
import { expect, test, type Locator } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

/** The rendered opacity of the element's background, via a canvas pixel. */
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

async function addLocationsUntilScrollable(
  page: import('@playwright/test').Page,
  dialog: Locator,
): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await dialog.getByTestId('project-location-add').click();
    const scrollable = await dialog.locator('[data-slot="dialog-body"]').evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    );
    if (scrollable) return;
  }
  throw new Error('the Create Project dialog did not become scrollable');
}

test('SC-01: the fixed footer is opaque, flush and contains the action', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 700 },
    { width: 390, height: 844 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/#/fixture?experience=web&projects=canonical');
    await page.getByTestId('project-create').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await addLocationsUntilScrollable(page, dialog);

    const footer = dialog.locator('[data-slot="dialog-footer"]');
    await expect(footer).not.toHaveAttribute('data-sticky');
    expect(await backgroundAlpha(footer), 'the footer band is opaque').toBe(1);

    const dialogBox = await dialog.boundingBox();
    const footerBox = await footer.boundingBox();
    const submitBox = await dialog.getByTestId('project-create-submit').boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    // Flush with the dialog's bottom edge, not floating above its padding.
    expect(
      Math.abs(footerBox!.y + footerBox!.height - (dialogBox!.y + dialogBox!.height)),
    ).toBeLessThanOrEqual(1);
    // The action lives inside the band at every tested width.
    expect(submitBox!.y).toBeGreaterThanOrEqual(footerBox!.y - 0.5);
    expect(submitBox!.y + submitBox!.height).toBeLessThanOrEqual(
      footerBox!.y + footerBox!.height + 0.5,
    );
    expect(submitBox!.x + submitBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);

    // Scrolling to the end keeps the band in the same place and opaque.
    await dialog.locator('[data-slot="dialog-body"]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const scrolledFooter = await footer.boundingBox();
    expect(scrolledFooter!.y).toBeCloseTo(footerBox!.y, 0);
    expect(await backgroundAlpha(footer)).toBe(1);
    observed.push(`${viewport.width}: opaque flush band, action inside, scrolling stable`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': measured ' + observed.join(' | '),
  });
});

test('SC-01: a short dialog keeps the same fixed opaque footer', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  // Rename is a short dialog: it must not scroll and its footer is the same
  // opaque, flush band, not a legacy in-flow translucent variant.
  const projectRow = page.getByTestId('project-item-row').first();
  const projectId = await projectRow.getAttribute('data-project-id');
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const rename = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await expect(rename).toBeVisible();
  const footer = rename.locator('[data-slot="dialog-footer"]');
  await expect(footer).not.toHaveAttribute('data-sticky');
  expect(await backgroundAlpha(footer), 'the short-dialog band is opaque').toBe(1);
  const dialogBox = await rename.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(Math.abs(footerBox!.y + footerBox!.height - (dialogBox!.y + dialogBox!.height)))
    .toBeLessThanOrEqual(1);
  expect(
    await rename.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the short Rename Project dialog kept a non-scrolling surface and the same opaque flush footer band',
  });
});
