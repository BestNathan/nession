// #3164 SC-03: the interaction contract around the new row grammar. Pointer,
// keyboard and emulated App touch selection still choose/close/restore focus as
// before; the list stays a nested anchored layer (not a full-screen modal)
// inside a dialog, outside dismissal and unavailable states do not mutate; the
// dark token variant keeps selected/focused rows legible.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock, waitForFixtureTerminal } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function openWebAgentSelect(page: Page): Promise<{
  dialog: Locator;
  trigger: Locator;
  list: Locator;
  options: Locator;
}> {
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
  // Base UI focuses the selected option on the next animation frame. Keyboard
  // assertions must start after that; otherwise ArrowDown races the open.
  await expect.poll(async () =>
    page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('option');
  return { dialog, trigger, list, options: list.getByRole('option') };
}

async function contrast(page: Page, item: Locator): Promise<{ title: number; status: number }> {
  return item.evaluate((element) => {
    const luminance = (css: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (foreground: string, background: string) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const background = getComputedStyle(element).backgroundColor;
    const title = element.querySelector('[data-slot="choice-item-title"]')!;
    const status = element.querySelector('[data-slot="choice-item-status"]')!;
    return {
      title: ratio(getComputedStyle(title).color, background),
      status: ratio(getComputedStyle(status).color, background),
    };
  });
}

async function waitForDarkSurface(page: Page, item: Locator): Promise<void> {
  // Switching the token variant repaints the dialog surface asynchronously.
  // Measure only after that surface is actually dark, or the contrast read
  // races a light-mode intermediate frame.
  await expect
    .poll(
      async () =>
        item.evaluate((element) => {
          const dialog = element.closest('[data-slot="dialog-content"]');
          if (!dialog) return 1;
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext('2d')!;
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(dialog).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
          const channel = (value: number) => {
            const normalized = value / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        }),
      { message: 'dialog surface must repaint under the dark token variant' },
    )
    .toBeLessThan(0.25);
}

test('SC-03: pointer and keyboard selection keep focus and dismissal ownership', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { dialog, trigger, list, options } = await openWebAgentSelect(page);

  // Arrow navigation moves the active row; Enter selects and closes the list,
  // returning focus to the trigger.
  await expect(options.first()).toHaveAttribute('data-highlighted', '');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('data-highlighted', '');
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(trigger).toContainText('macbook');
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
  await expect(dialog).toBeVisible();

  // Escape closes only the anchored layer first; a second Escape closes the
  // dialog.
  await trigger.click();
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Pointer selection commits the row and restores the trigger.
  const reopened = await openWebAgentSelect(page);
  await reopened.options.nth(2).click();
  await expect(reopened.list).toHaveCount(0);
  await expect(reopened.trigger).toContainText('sg-prod');
  await expect(reopened.dialog).toBeVisible();

  // An outside pointer press dismisses the anchored list but not the dialog.
  await reopened.trigger.click();
  await expect(reopened.list).toBeVisible();
  await reopened.dialog.click({ position: { x: 10, y: 10 } });
  await expect(reopened.list).toHaveCount(0);
  await expect(reopened.dialog).toBeVisible();
  await page.keyboard.press('Escape');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Arrow navigation + Enter committed macbook and returned focus to the ' +
      'trigger; Escape closed the list first and focus returned before the dialog closed; pointer ' +
      'selection committed sg-prod with the dialog still open',
  });
});

test('SC-03: unavailable state stays explicit without mutating', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=offline');
  await page.reload();
  await waitForFixtureTerminal(page);
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByTestId('create-session-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('project-location-trigger').click();
  const list = page.locator('[role="listbox"]:visible');
  await expect(list).toBeVisible();
  const item = list.getByRole('option').first();
  await expect(item.locator('[data-slot="choice-item-status"]')).toHaveText('Agent offline');
  await expect(item.locator('[data-slot="choice-item-status"]')).toHaveClass(/text-destructive/);
  await expect(page.getByTestId('project-location-offline')).toBeVisible();
  await expect(page.getByTestId('create-session-submit')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.getByTestId('session-item-row').count()).toBe(6);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the offline location carried an explicit destructive "Agent offline" ' +
      'status, Create stayed disabled, and Escape dismissed only the list then the dialog without ' +
      'creating a Session',
  });
});

test('SC-03: dark selected and focused rows stay legible', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=long');
  await page.reload();
  await waitForFixtureTerminal(page);
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  await page.getByTestId('project-location-trigger').click();
  const list = page.locator('[role="listbox"]:visible');
  await expect(list).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await waitForDarkSurface(page, list.getByRole('option').first());
  const items = list.getByRole('option');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toHaveAttribute('data-highlighted', '');

  const selected = await contrast(page, items.first());
  const focused = await contrast(page, items.nth(1));
  expect(selected.title).toBeGreaterThanOrEqual(4.5);
  expect(selected.status).toBeGreaterThanOrEqual(4.5);
  expect(focused.title).toBeGreaterThanOrEqual(4.5);
  expect(focused.status).toBeGreaterThanOrEqual(4.5);
  const selectedBackground = await items.first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
  await expect(items.first().locator('[data-slot="select-item-indicator"]')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': under the dark token variant the selected row kept its quiet surface ' +
      'and check, with title/status contrast ' + selected.title.toFixed(2) + '/' +
      selected.status.toFixed(2) + '; the focused row measured ' + focused.title.toFixed(2) + '/' +
      focused.status.toFixed(2),
  });
});

test.describe('App touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('SC-03: App touch selection keeps the anchored list nested in its dialog', async ({ page }) => {
    test.setTimeout(110_000);
    const { sha } = verifiedRuntime('SC-03');
    await freezeFixtureClock(page);
    await page.goto('/#/fixture/app?projects=canonical');
    await page.reload();
    await page.getByTestId('app-layer-root').waitFor();
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page.getByTestId('project-create').tap();
    const pageSurface = page.getByTestId('app-project-create-page');
    await expect(pageSurface).toBeVisible();
    await page.getByTestId('project-location-add').tap();
    const trigger = page.locator('#project-create-location-agent-0');
    await trigger.tap();
    const list = page.locator('[role="listbox"]:visible');
    await expect(list).toBeVisible();
    const options = list.getByRole('option');
    await expect(options).toHaveCount(3);

    // The list is a nested anchored layer, not a full-screen conversion, and
    // remains in the dialog's accessible tree.
    const placement = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="select-content"]')!;
      const dialog = popup.closest('[data-slot="dialog-content"]')!;
      return {
        insideDialog: dialog !== null,
        ariaHidden: popup.closest('[aria-hidden="true"]') !== null,
        popupZ: Number(getComputedStyle(popup).zIndex),
        dialogZ: Number(getComputedStyle(dialog).zIndex),
        popupHeight: popup.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
      };
    });
    expect(placement.insideDialog).toBe(true);
    expect(placement.ariaHidden).toBe(false);
    expect(placement.popupZ).toBeGreaterThan(placement.dialogZ);
    expect(placement.popupHeight).toBeLessThan(placement.viewportHeight - 100);

    // Touch chooses a row; the trigger and dialog stay, and Escape still closes
    // only the list first.
    await options.nth(1).tap();
    await expect(list).toHaveCount(0);
    await expect(trigger).toContainText('macbook');
    await expect(pageSurface).toBeVisible();
    await trigger.tap();
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(pageSurface).toBeVisible();
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(pageSurface).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(391);

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': at 390 the App Select stayed a ' +
        Math.round(placement.popupHeight) + 'px anchored list inside the operation dialog, ' +
        'role-accessible (no aria-hidden ancestor), z ' + placement.popupZ + ' > ' +
        placement.dialogZ + '; tapping chose macbook with no full-screen conversion, and Escape ' +
        'closed the list before the dialog with trigger focus restored',
    });
  });

  test('SC-03: App action choices keep the existing touch floor', async ({ page }) => {
    test.setTimeout(110_000);
    const { sha } = verifiedRuntime('SC-03');
    await freezeFixtureClock(page);
    await page.goto('/#/fixture/app?projects=canonical');
    await page.reload();
    await page.getByTestId('app-layer-root').waitFor();
    await page.getByTestId('app-header-workspace').first().tap();
    await page.getByTestId('workspace-tool-env').tap();
    await page.getByTestId('env-profile-list').waitFor();
    await page.getByTestId('env-new-menu').tap();
    await page.getByTestId('env-import').tap();
    await expect(page.getByTestId('env-import-dialog')).toBeVisible();
    await page.getByTestId('env-import-location').tap();
    const list = page.locator('[role="listbox"]:visible');
    await expect(list).toBeVisible();
    const options = list.getByRole('option');
    await expect(options).toHaveCount(2);
    const band = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;min-height:var(--nession-control-sm)';
      const scope = document.querySelector('[data-testid="app-popup-portal"]') ?? document.body;
      scope.append(probe);
      const value = parseFloat(getComputedStyle(probe).minHeight);
      probe.remove();
      return value;
    });
    expect(band).toBe(44);
    for (let index = 0; index < 2; index += 1) {
      const option = options.nth(index);
      await expect(option).toHaveAttribute('data-anatomy', 'action');
      const box = await option.boundingBox();
      expect(box!.height).toBe(band);
      expect(
        await option
          .locator('[data-slot="select-item-text"]')
          .evaluate((element) => getComputedStyle(element).whiteSpace),
      ).toBe('nowrap');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(391);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId('env-import-dialog')).toBeVisible();

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': the App Env Import Location list kept its two action rows at the ' +
        band + 'px touch floor and single-line contract, with the dialog still open after Escape',
    });
  });
});
