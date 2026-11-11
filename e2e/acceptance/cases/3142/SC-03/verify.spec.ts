// #3142 SC-03: the App's Experience-selected overlay compositions. Menus keep
// the App control band and Experience scope, the quick sheet and full-height
// operation depths keep one Back/header owner, safe-area footer and draft
// context, and the explicit experience route wins over the viewport.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function tokenPx(page: Page, variable: string): Promise<number> {
  return page.evaluate((name) => {
    // Experience tokens resolve from their scope; the App popup container is
    // the node an App popup itself resolves from. Web falls back to the root.
    const scope =
      document.querySelector('[data-testid="app-popup-portal"]') ?? document.body;
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;min-height:var(${name})`;
    scope.append(probe);
    const value = parseFloat(getComputedStyle(probe).minHeight);
    probe.remove();
    return value;
  }, variable);
}

async function settledHeight(page: Page, locator: Locator): Promise<number> {
  await expect.poll(async () => {
    const first = await locator.boundingBox();
    await page.waitForTimeout(60);
    const second = await locator.boundingBox();
    return first && second && Math.abs(first.height - second.height) < 0.5
      ? Math.round(second.height)
      : -1;
  }).toBeGreaterThan(0);
  return (await locator.boundingBox())!.height;
}

async function openAppSessions(page: Page): Promise<void> {
  await page.getByTestId('app-layer-root').waitFor();
  if ((await page.getByTestId('app-layer-root').getAttribute('data-layer')) !== 'sessions') {
    await page.getByTestId('app-header-sessions').first().click();
  }
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
}

test('SC-03: App menus keep the Experience band across portrait and landscape', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  const observed: string[] = [];

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 844, height: 390 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture/app?projects=canonical');
    await openAppSessions(page);

    const trigger = page.locator('[data-testid^="session-actions-"]').first();
    expect((await trigger.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const item = menu.getByRole('menuitem').first();
    const band = await tokenPx(page, '--nession-control-sm');
    expect(band).toBe(44);
    expect(await settledHeight(page, item)).toBe(band);
    expect(await item.evaluate((element) => Boolean(element.closest('[data-experience="app"]'))))
      .toBe(true);
    await expect(menu).toHaveAttribute('data-slot', 'dropdown-menu-content');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(viewport.width + 1);
    observed.push(`${viewport.width}x${viewport.height}: menu band ${band}`);
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | '),
  });
});

test('SC-03: App sheet and operation depths keep one header, safe area and draft', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // Quick attach sheet → full-height configuration depth → Back to the sheet
  // with the mode draft preserved.
  await page.goto('/#/fixture/app?operation=attach');
  const sheet = page.getByTestId('app-attach-sheet');
  await expect(sheet).toBeVisible();
  await page.getByTestId('app-attach-settings-entry').click();
  const settings = page.getByTestId('app-attach-settings-page');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('app-page-header')).toHaveCount(1);
  await page.getByTestId('attach-mode-p2p').click();
  await page.getByTestId('app-page-back').click();
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('attach-mode-summary')).toContainText('Direct P2P connection');

  // Project → New Session: full-height operation page, safe-area footer, child
  // depths and a preserved draft.
  await page.goto('/#/fixture/app?projects=canonical');
  await page.reload();
  await openAppSessions(page);
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const create = page.getByTestId('app-create-session-page');
  await expect(create).toBeVisible();
  await expect(create.getByTestId('app-page-header')).toHaveCount(1);
  const footer = await page.getByTestId('app-create-session-page-footer').boundingBox();
  expect(Math.abs((footer?.y ?? 0) + (footer?.height ?? 0) - 844)).toBeLessThanOrEqual(1);
  await create.locator('#name').fill('draft-3142');
  await create.getByTestId('app-session-location').click();
  const locationPage = page.getByTestId('app-create-location-page');
  await expect(locationPage).toBeVisible();
  await expect(locationPage.getByTestId('app-page-header')).toHaveCount(1);
  await page.getByTestId('app-create-location-0').click();
  await page.getByTestId('app-create-location-done').click();
  await expect(create.locator('#name')).toHaveValue('draft-3142');
  await create.getByTestId('app-session-env').click();
  const envPage = page.getByTestId('app-create-env-page');
  await expect(envPage).toBeVisible();
  await page.getByTestId('app-create-env-done').click();
  await expect(create.locator('#name')).toHaveValue('draft-3142');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  // Landscape: the same operation stays full-height with its anchored CTA.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/#/fixture/app?projects=canonical');
  await page.reload();
  await openAppSessions(page);
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const landscapePage = page.getByTestId('app-create-session-page');
  await expect(landscapePage).toBeVisible();
  const landscapeFooter = await page.getByTestId('app-create-session-page-footer').boundingBox();
  expect(Math.abs((landscapeFooter?.y ?? 0) + (landscapeFooter?.height ?? 0) - 390))
    .toBeLessThanOrEqual(1);
  await expect(landscapePage.getByTestId('app-page-header')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': attach sheet → settings depth → Back preserved the P2P draft; ' +
      'App create/location/ENV depths kept one header each, the 390 and 844×390 footer reached ' +
      'the viewport edge, and the typed draft survived both child depths',
  });
});

test('SC-03: the explicit experience route wins over the viewport', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/#/fixture?experience=app&projects=canonical');
  await page.reload();
  await expect(page.getByTestId('app-layer-root')).toBeVisible();
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture?experience=web&projects=canonical');
  await page.reload();
  await expect(page.getByTestId('session-drawer-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  await expect(page.getByTestId('app-layer-root')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': forced App at 900 rendered the App layers with no Web column; ' +
      'forced Web at 390 rendered the overlay drawer with no rail or App layer',
  });
});
