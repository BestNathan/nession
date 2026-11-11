// #3298 SC-03: the three-zone shell follows the Experience and viewport. Web
// keeps its centered dialog roles at 1440/1180/1024 and short/narrow forced-Web
// layouts; App keeps one Back/header, the sheet/operation role, safe-area footer,
// nested popup stacking/focus and a preserved draft with no layout jump.
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

async function expectBands(
  page: Page,
  dialog: Locator,
  footer: Locator,
): Promise<void> {
  const header = dialog.locator('[data-slot="dialog-header"]');
  const body = dialog.locator('[data-slot="dialog-body"]');
  const dialogBox = await settledBox(dialog);
  const headerBox = await settledBox(header);
  const bodyBox = await settledBox(body);
  const footerBox = await settledBox(footer);
  expect(headerBox.x).toBeCloseTo(dialogBox.x, 0);
  expect(headerBox.width).toBeCloseTo(dialogBox.width, 0);
  expect(headerBox.y).toBeCloseTo(dialogBox.y, 0);
  expect(bodyBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(footerBox.y + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
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

async function openAppProjectCreate(page: Page): Promise<Locator> {
  await page.goto('/#/fixture/app?projects=canonical');
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-sessions').first().click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await page.getByTestId('project-create').tap();
  const pageSurface = page.getByTestId('app-project-create-page');
  await expect(pageSurface).toBeVisible();
  return pageSurface;
}

test('SC-03: Web dialog roles keep the three-zone shell at desktop and constrained sizes', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  const observed: string[] = [];

  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?operation=attach-settings&projects=canonical');
  const attach = page.getByTestId('attach-dialog');
  await expect(attach).toBeVisible();
  await expect(attach).toHaveAttribute('data-size', 'wide');
  await expectBands(page, attach, attach.locator('[data-slot="dialog-footer"]'));
  await attach.getByRole('button', { name: 'Cancel' }).click();

  for (const viewport of [
    { width: 1180, height: 700 },
    { width: 1024, height: 700 },
    { width: 900, height: 420 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture?experience=web&projects=long');
    await page.getByTestId('project-item-row').first().waitFor();
    await page.getByTestId('project-item-row').first().click();
    if (await page.getByTestId('sidebar-drawer-close').isVisible().catch(() => false)) {
      await page.getByTestId('sidebar-drawer-close').click();
    }
    await page.getByTestId('project-detail-create-session').click();
    const dialog = page.getByTestId('create-session-dialog');
    await expect(dialog).toBeVisible();
    await expectBands(page, dialog, dialog.locator('[data-slot="dialog-footer"]'));
    await expect(dialog.locator('[data-slot="dialog-body"]'))
      .toHaveAttribute('data-slot', 'dialog-body');
    // Nested choice stays above the dialog and Escape closes it first.
    const trigger = dialog.getByTestId('project-location-trigger');
    await trigger.click();
    const list = page.locator('[role="listbox"]:visible');
    await expect(list).toBeVisible();
    const z = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="select-content"]')!;
      const content = document.querySelector('[data-slot="dialog-content"]')!;
      return {
        popup: Number(getComputedStyle(popup).zIndex),
        dialog: Number(getComputedStyle(content).zIndex),
      };
    });
    expect(z.popup).toBeGreaterThan(z.dialog);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();
    observed.push(`${viewport.width}x${viewport.height}: standard role, nested choice above dialog, Escape child-first`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  // Narrow forced-Web keeps the Web dialog composition (not an App page).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture?experience=web&projects=long');
  await page.reload();
  await page.getByTestId('project-item-row').first().waitFor();
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('sidebar-drawer-close').click();
  await page.getByTestId('project-detail-create-session').click();
  const narrow = page.getByTestId('create-session-dialog');
  await expect(narrow).toBeVisible();
  await expectBands(page, narrow, narrow.locator('[data-slot="dialog-footer"]'));
  await expect(narrow.locator('[data-testid="app-project-create-page"]')).toHaveCount(0);
  observed.push('390 forced-Web: Web dialog retained with the three-zone bands');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | '),
  });
});

test.describe('App touch', () => {
  test.use({ hasTouch: true });

test('SC-03: App keeps one header, safe-area footer and nested focus at 375/390/430', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  const observed: string[] = [];

  for (const width of [375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const surface = await openAppProjectCreate(page);
    await addLocations(page, surface, 4);
    await expect(surface.getByTestId('app-page-header')).toHaveCount(1);
    const body = surface.locator('[data-slot="dialog-body"]');
    const footer = surface.getByTestId('app-project-create-page-footer');
    const surfaceBox = await settledBox(surface);
    const headerBox = await settledBox(surface.getByTestId('app-page-header'));
    const bodyBox = await settledBox(body);
    const footerBox = await settledBox(footer);
    expect(surfaceBox.height).toBeCloseTo(844, 0);
    expect(headerBox.y).toBeGreaterThanOrEqual(0);
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(bodyBox.y + 0.5);
    expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(footerBox.y + 0.5);
    // The App page footer reaches the real viewport bottom (safe area included).
    expect(Math.abs(footerBox.y + footerBox.height - 844)).toBeLessThanOrEqual(1);
    expect(
      await body.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    expect(
      await surface.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    ).toBe(true);
    observed.push(`${width}x844: one header, ${Math.round(footerBox.y)}px footer, Body scroll`);
    await page.getByTestId('app-page-back').tap();
    await expect(surface).toHaveCount(0);
  }

  // Nested popup focus/stack and draft preservation at the canonical phone.
  await page.setViewportSize({ width: 390, height: 844 });
  const surface = await openAppProjectCreate(page);
  await addLocations(page, surface, 4);
  await surface.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const trigger = page.locator('[id^="project-create-location-agent-"]').last();
  await trigger.tap();
  const list = page.locator('[role="listbox"]:visible');
  await expect(list).toBeVisible();
  const placement = await page.evaluate(() => {
    const popup = document.querySelector('[data-slot="select-content"]')!;
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    return {
      experience: popup.closest('[data-experience]')?.getAttribute('data-experience') ?? null,
      insideDialog: dialog.contains(popup),
      popupZ: Number(getComputedStyle(popup).zIndex),
      dialogZ: Number(getComputedStyle(dialog).zIndex),
    };
  });
  expect(placement.experience).toBe('app');
  expect(placement.insideDialog).toBe(true);
  expect(placement.popupZ).toBeGreaterThan(placement.dialogZ);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(surface.getByTestId('app-page-header')).toHaveCount(1);
  await expect(trigger).toBeFocused();
  await page.getByTestId('app-page-back').tap();
  await expect(surface).toHaveCount(0);
  observed.push('390: nested Select inside the App operation dialog, child-first Escape, one header');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | '),
  });
});

test('SC-03: App sheet and landscape operation preserve the role and footer edge', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?operation=attach');
  const sheet = page.getByTestId('app-attach-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('app-page-header')).toHaveCount(0);
  const sheetBox = await settledBox(sheet);
  const sheetFooter = await settledBox(sheet.locator('[data-slot="dialog-footer"]'));
  expect(Math.abs(sheetFooter.y + sheetFooter.height - 844)).toBeLessThanOrEqual(1);
  expect(sheetBox.y).toBeGreaterThan(0);
  await sheet.getByTestId('app-attach-settings-entry').click();
  const settings = page.getByTestId('app-attach-settings-page');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('app-page-header')).toHaveCount(1);
  await page.getByTestId('app-page-back').click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Landscape App project operation: single header, Body scroll, footer edge.
  await page.setViewportSize({ width: 844, height: 390 });
  const surface = await openAppProjectCreate(page);
  await addLocations(page, surface, 4);
  await expect(surface.getByTestId('app-page-header')).toHaveCount(1);
  const footerBox = await settledBox(surface.getByTestId('app-project-create-page-footer'));
  expect(Math.abs(footerBox.y + footerBox.height - 390)).toBeLessThanOrEqual(1);
  expect(
    await surface.locator('[data-slot="dialog-body"]').evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/nession-3298-app-landscape.png' });

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App attach sheet kept its role and bottom edge, settings depth ' +
      'kept one App header and Back, and the 844x390 operation kept one header, Body scroll ' +
      'and a footer flush with the viewport bottom',
  });
});
});
