// #3089 SC-07: the Web Project → New Session Existing Location uses a
// content-sized Select. The trigger contains Agent, wrapped Directory and
// status at 1440/1180/1024 and narrow forced Web; the anchored options wrap a
// long path inside their own width, pointer/keyboard selection works, and the
// dialog stays the only vertical scroll owner.
import { expect, test } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function openProjectSession(
  page: import('@playwright/test').Page,
  search: string,
  narrow: boolean,
) {
  await freezeFixtureClock(page);
  await page.goto(`/#/fixture?experience=web&projects=${search}`);
  await expect(page.getByTestId('project-item-row').first()).toBeVisible();
  await page.getByTestId('project-item-row').first().click();
  if (narrow) {
    await page.getByTestId('sidebar-drawer-close').click();
  }
  await page.getByTestId('project-detail-create-session').click();
  return page.getByRole('dialog').filter({ hasText: 'Create Session in' });
}

async function expectInsideTrigger(
  page: import('@playwright/test').Page,
  viewportWidth: number,
) {
  const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
  const trigger = dialog.getByTestId('project-location-trigger');
  await expect(trigger).toHaveAttribute('data-size', 'content');
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(triggerBox!.height).toBeGreaterThan(60);
  expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(viewportWidth + 0.5);

  const path = trigger.getByTestId('project-location-path');
  const pathBox = await path.boundingBox();
  expect(pathBox).not.toBeNull();
  expect(pathBox!.y).toBeGreaterThanOrEqual(triggerBox!.y - 0.5);
  expect(pathBox!.y + pathBox!.height).toBeLessThanOrEqual(
    triggerBox!.y + triggerBox!.height + 0.5,
  );
  expect(await path.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  // The dialog is the one scroll owner; the form itself does not scroll.
  expect(
    await dialog.locator('form').evaluate((element) => getComputedStyle(element).overflowY),
  ).toBe('visible');
  return trigger;
}

test('SC-07: Existing Location trigger and options contain long content', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-07');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900, narrow: false },
    { width: 1180, height: 900, narrow: false },
    { width: 1024, height: 700, narrow: false },
    { width: 390, height: 844, narrow: true },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const dialog = await openProjectSession(page, 'long', viewport.narrow);
    const trigger = await expectInsideTrigger(page, viewport.width);

    await trigger.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    const popup = page.locator('[data-slot="select-content"]');
    const popupBox = await popup.boundingBox();
    expect(popupBox).not.toBeNull();
    expect(popupBox!.width).toBeCloseTo((await trigger.boundingBox())!.width, 0);
    expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    for (const option of await options.all()) {
      const optionBox = await option.boundingBox();
      expect(optionBox).not.toBeNull();
      expect(optionBox!.width).toBeLessThanOrEqual(popupBox!.width + 0.5);
      expect(
        await option.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      const optionPath = option.getByTestId('project-location-path');
      const optionPathBox = await optionPath.boundingBox();
      expect(optionPathBox).not.toBeNull();
      expect(optionPathBox!.x).toBeGreaterThanOrEqual(optionBox!.x - 0.5);
      expect(optionPathBox!.x + optionPathBox!.width).toBeLessThanOrEqual(
        optionBox!.x + optionBox!.width + 0.5,
      );
      // Options carry Agent + path; status belongs to the selected trigger.
      await expect(option).not.toContainText('Agent online');
      await expect(option).not.toContainText('Agent offline');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(viewport.width + 1);

    // Escape closes only the Select and returns focus to its trigger.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // Keyboard selection moves to the second location.
    await trigger.press('ArrowDown');
    const secondOption = page.getByRole('option').nth(1);
    await expect(secondOption).toBeVisible();
    await secondOption.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toContainText('devbox-01');

    // Pointer selection returns to the first location.
    await trigger.click();
    await page.getByRole('option').first().click();
    await expect(trigger).toContainText('macbook');
    await expect(trigger).toContainText('fix-3089-select-location-geometry');
    const selectedBox = await trigger.boundingBox();
    expect(selectedBox).not.toBeNull();
    expect(selectedBox!.y + selectedBox!.height).toBeLessThanOrEqual(
      viewport.height + 0.5,
    );
    await expectInsideTrigger(page, viewport.width);
    observed.push(
      `${viewport.width}: trigger ${selectedBox!.width.toFixed(0)}x${selectedBox!.height.toFixed(0)}, ` +
        '2 wrapped options, pointer+keyboard selection, 0 horizontal overflow',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': measured content-sized Existing Location at ' + observed.join(' | '),
  });
});

test('SC-07: offline and empty Existing Location states stay explicit', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-07');
  await page.setViewportSize({ width: 1180, height: 800 });

  const offlineDialog = await openProjectSession(page, 'offline', false);
  const offlineTrigger = offlineDialog.getByTestId('project-location-trigger');
  await expect(offlineTrigger).toContainText('Agent offline');
  await expect(offlineDialog.getByTestId('project-location-offline')).toBeVisible();
  await expect(offlineDialog.getByTestId('create-session-submit')).toBeDisabled();
  await expectInsideTrigger(page, 1180);
  await offlineDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(offlineDialog).toHaveCount(0);

  // The second canonical Project declares no Existing Location.
  await page.goto('/#/fixture?experience=web&projects=canonical');
  await page.reload();
  await page.getByTestId('project-item-row').nth(1).click();
  await page.getByTestId('project-detail-create-session').click();
  const emptyDialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
  await expect(emptyDialog.getByText(/No Existing Location/)).toBeVisible();
  await expect(emptyDialog.getByTestId('project-location-trigger')).toHaveCount(0);
  await expect(emptyDialog.getByTestId('create-session-submit')).toBeDisabled();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': offline Existing Location kept the content-sized trigger and explicit ' +
      'offline line with Create disabled; a Project without locations rendered the empty message ' +
      'and no Select trigger',
  });
});
