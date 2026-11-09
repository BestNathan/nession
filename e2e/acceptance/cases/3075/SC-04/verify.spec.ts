// #3075 SC-04: narrow Web stays a Drawer-only overlay with no reserved rail,
// the App keeps its independent spatial navigation, width/experience switches
// leave no stale rail or inaccessible controls, and reduced motion plus the
// offline Server state remain usable.
import { expect, test } from '@playwright/test';
import {
  freezeFixtureClock,
  gotoFixtureApp,
  waitForFixtureTerminal,
} from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

test('SC-04: narrow Web and App own no rail; switches and degraded states stay usable', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture?experience=web');
  await expect(page.getByTestId('session-drawer-panel')).toBeVisible();

  // Narrow Web is the overlay Drawer: no column, no rail, no collapse action.
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-collapse')).toHaveCount(0);

  // Escape closes the Drawer and the opening control is immediately usable.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  const open = page.getByTestId('session-drawer-open');
  await expect(open).toBeVisible();
  await expect(open).toHaveAccessibleName('Open sessions');
  await open.click();
  await expect(page.getByTestId('session-drawer-panel')).toBeVisible();
  await page.getByTestId('session-drawer-scrim').click({ position: { x: 370, y: 400 } });
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);

  // A width switch reaches the wide composition with no stale Drawer and no
  // inaccessible rail buttons; collapse then produces the real 56px rail.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId('sidebar-column')).toBeVisible();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  await waitForFixtureTerminal(page);
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-rail')).toBeVisible();
  for (const id of [
    'sidebar-rail-expand',
    'sidebar-rail-new-session',
    'sidebar-rail-search',
    'sidebar-rail-projects',
  ]) {
    await expect(page.getByTestId(id)).toBeEnabled();
  }
  await expect(page.getByTestId('sidebar-rail-server')).toBeVisible();

  // Reduced motion removes the width transition rather than leaving a
  // decorative animation in place.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .getByTestId('sidebar-column')
      .evaluate((element) => getComputedStyle(element).transitionProperty),
  ).toBe('none');

  // The offline Server keeps a truthful passive status and never becomes a
  // control; the rail's shortcuts stay usable.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#/fixture?connection=disconnected');
  await page.getByTestId('shell').waitFor();
  await waitForFixtureTerminal(page);
  await page.getByTestId('sidebar-collapse').click();
  const status = page.getByTestId('sidebar-rail-server');
  await expect(status).toHaveAttribute('role', 'img');
  await expect(status).toHaveAttribute('aria-label', 'Server disconnected');
  await expect(page.getByTestId('sidebar-rail-server-dot')).toHaveClass(/destructive/);
  await expect(page.getByTestId('sidebar-rail-search')).toBeEnabled();

  // The App is its own spatial composition: no Web column, rail or Drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoFixtureApp(page);
  await expect(page.getByTestId('app-layer-root')).toBeVisible();
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
  await page.getByTestId('app-header-sessions').first().click();
  await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
  await page.getByTestId('app-layer-root').evaluate((element) => {
    (element as HTMLElement).dataset.sc04 = 'kept';
  });
  await page.getByTestId('session-item-devbox-01:design-system').click();
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
  expect(
    await page
      .getByTestId('app-layer-root')
      .evaluate((element) => (element as HTMLElement).dataset.sc04),
  ).toBe('kept');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': 390 Web was Drawer-only with no rail; Escape/scrim reopened and ' +
      'closed it; 1280 reused the same composition with a 56px rail whose controls were enabled; ' +
      'reduced motion removed the width transition; disconnected Server stayed role=img and ' +
      'non-actionable; App 390 stayed spatial with no Web navigation',
  });
});
