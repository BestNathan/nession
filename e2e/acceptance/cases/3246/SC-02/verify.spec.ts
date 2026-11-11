// #3246 SC-02: Dialog-hosted and App Selects keep trigger-relative anchoring.
// A Web Select inside a scrolling modal stays attached when the dialog scrolls,
// remains inside the dialog's popup host/focus tree, and keeps its ARIA
// relationship. In the App Experience (375/390/430, touch), the same Select
// resolves the App scope, keeps the 44px row floor, honours a top flip when the
// trigger is near the bottom edge, and reopens with the same anchor after
// scrolling. No Portal/transform/scroll displacement is accepted as a normal
// no-collision offset.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock, waitForFixtureTerminal } from '../../../../helpers/fixtureVisual';
import { expectSelectAnchored, settledBox } from '../../../../helpers/selectAnchor';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

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

async function placement(page: Page, trigger: Locator) {
  const popup = page.locator('[data-slot="select-content"]:visible');
  await expect(popup).toBeVisible();
  const popupBox = await settledBox(page, popup);
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox).not.toBeNull();
  const details = await popup.evaluate((element) => {
    const dialog = element.closest('[data-slot="dialog-content"]');
    const portal = element.closest('[data-slot="dialog-popup-portal"]');
    const style = getComputedStyle(element);
    return {
      insideDialog: dialog !== null,
      insideDialogHost: portal !== null,
      ariaHidden: element.closest('[aria-hidden="true"]') !== null,
      experience: element.closest('[data-experience]')?.getAttribute('data-experience') ?? null,
      popupZ: Number(style.zIndex),
      dialogZ: dialog ? Number(getComputedStyle(dialog).zIndex) : -1,
    };
  });
  return { popupBox, triggerBox: triggerBox!, details };
}

test('SC-02: a Dialog Select stays anchored through scrolling and modal containment', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await waitForFixtureTerminal(page);
  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  await addLocations(page, dialog, 5);

  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  const trigger = page.locator('#project-create-location-agent-0');
  await trigger.click();
  const first = await expectSelectAnchored(page, trigger);
  const firstPlacement = await placement(page, trigger);
  expect(firstPlacement.details.insideDialog).toBe(true);
  expect(firstPlacement.details.insideDialogHost).toBe(true);
  expect(firstPlacement.details.ariaHidden).toBe(false);
  expect(firstPlacement.details.popupZ).toBeGreaterThan(firstPlacement.details.dialogZ);

  // The trigger and the list form one ARIA relationship, and opening moves
  // focus into the list without leaving the modal.
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const controls = await trigger.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  const list = page.locator(`[id="${controls}"]`);
  await expect(list).toHaveAttribute('role', 'listbox');
  await expect(list.getByRole('option')).toHaveCount(3);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
    .toBe('option');

  // Scrolling the dialog while the list is open must move both boxes together,
  // not leave the popup at a stale viewport position.
  await dialog.evaluate((element) => {
    element.scrollBy(0, 90);
  });
  const scrolled = await expectSelectAnchored(page, trigger);
  expect(Math.abs(scrolled.dx - first.dx)).toBeLessThanOrEqual(2);
  expect(Math.abs(scrolled.gap - first.gap)).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
  await expect(dialog).toBeVisible();

  // Scroll to the bottom and re-open from a different location row: the host
  // still anchors the list to that row, whether Base UI keeps it below or
  // legally flips it.
  const triggers = page.locator('[id^="project-create-location-agent-"]');
  const last = triggers.last();
  await dialog.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await last.click();
  const reopened = await expectSelectAnchored(page, last);
  const reopenedPlacement = await placement(page, last);
  expect(reopenedPlacement.details.insideDialogHost).toBe(true);
  expect(['bottom', 'top']).toContain(reopened.side);
  await page.getByRole('option').last().click();
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(last).not.toHaveText(/Select an agent|Choose an agent/);

  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': 1440 Dialog Select dx=' + first.dx.toFixed(1) +
      ' gap=' + first.gap.toFixed(1) + '; after dialog scroll dx=' + scrolled.dx.toFixed(1) +
      ' gap=' + scrolled.gap.toFixed(1) + '; popup inside dialog host with z ' +
      firstPlacement.details.popupZ + ' > ' + firstPlacement.details.dialogZ +
      '; reopened from the bottom row as ' + reopened.side + ' dx=' + reopened.dx.toFixed(1) +
      ' gap=' + reopened.gap.toFixed(1) + ' with trigger focus restored',
  });
});

test.describe('App touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('SC-02: App Selects keep the Experience scope and anchor at 375/390/430', async ({ page }) => {
    test.setTimeout(110_000);
    const { sha } = verifiedRuntime('SC-02');
    await freezeFixtureClock(page);
    const observed: string[] = [];

    for (const width of [375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/#/fixture/app?projects=canonical');
      await page.reload();
      await page.getByTestId('app-layer-root').waitFor();
      await page.getByTestId('app-header-sessions').first().click();
      await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
      await page.getByTestId('project-create').tap();
      const surface = page.getByTestId('app-project-create-page');
      await expect(surface).toBeVisible();
      await addLocations(page, surface, 4);

      // Scroll the operation page so the last row opens from a scrolled anchor.
      await surface.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const triggers = page.locator('[id^="project-create-location-agent-"]');
      const trigger = triggers.last();
      await trigger.tap();
      const anchor = await expectSelectAnchored(page, trigger);
      expect(['bottom', 'top']).toContain(anchor.side);
      const placementNow = await placement(page, trigger);
      expect(placementNow.details.experience).toBe('app');
      expect(placementNow.details.insideDialog).toBe(true);
      expect(placementNow.details.insideDialogHost).toBe(true);
      expect(placementNow.details.ariaHidden).toBe(false);
      expect(placementNow.details.popupZ).toBeGreaterThan(placementNow.details.dialogZ);

      const options = page.locator('[role="listbox"]:visible').getByRole('option');
      await expect(options).toHaveCount(3);
      for (let index = 0; index < 3; index += 1) {
        const optionBox = await options.nth(index).boundingBox();
        expect(optionBox).not.toBeNull();
        expect(Math.round(optionBox!.height)).toBeGreaterThanOrEqual(44);
      }
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const controls = await trigger.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute('role', 'listbox');
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
        .toBe('option');

      // Escape closes only the list and restores trigger focus; the operation
      // surface remains the modal container.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('option')).toHaveCount(0);
      await expect(surface).toBeVisible();
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

      // Re-scroll and reopen: no accumulated Portal/transform offset.
      await surface.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await trigger.tap();
      const reopened = await expectSelectAnchored(page, trigger);
      expect(Math.abs(reopened.dx - anchor.dx)).toBeLessThanOrEqual(2);
      expect(Math.abs(reopened.gap - anchor.gap)).toBeLessThanOrEqual(2);
      await options.last().tap();
      await expect(page.getByRole('option')).toHaveCount(0);
      await expect(surface).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      observed.push(
        `${width}: ${anchor.side} dx=${anchor.dx.toFixed(1)} gap=${anchor.gap.toFixed(1)}, ` +
          `App scope + 44px rows, reopen dx=${reopened.dx.toFixed(1)} gap=${reopened.gap.toFixed(1)}`,
      );
      await page.keyboard.press('Escape');
      await expect(surface).toHaveCount(0);
    }

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': App touch Selects at 375/390/430 stayed inside the ' +
        'operation dialog/popup host with the App scope and 44px rows; ' + observed.join(' | '),
    });
  });
});
