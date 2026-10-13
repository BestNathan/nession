// #561 Phase 7–8 / #548 — focused visual regression for canonical fixture routes.
// Functional assertions run first; screenshots are the drift gate afterward.
// Baseline update: CI=true npx playwright test fixture-visual --update-snapshots=all
import { expect, test, type Locator } from '@playwright/test';
import { openCapsuleCapability } from '../../helpers/capsule';
import {
  FIXTURE_SCREENSHOT,
  expectChromeRegion,
  freezeFixtureClock,
  gotoFixtureApp,
  gotoFixtureShell,
  gotoFixtureWorkspace,
  openFixtureFile,
  waitForFixtureTerminal,
} from '../../helpers/fixtureVisual';

test.skip(!process.env.CI, 'canonical visual regression runs in CI only');

test.beforeEach(async ({ page }) => {
  await freezeFixtureClock(page);
});

/** The field's painted height right now. */
async function fieldHeight(field: Locator): Promise<number> {
  return field.evaluate((el) => el.getBoundingClientRect().height);
}

/**
 * The field's height sampled across one animation frame.
 *
 * The multiline case needs this because the layout attribute it could poll
 * instead (`data-dock-height`) flips on the commit that *starts* the field's
 * height transition (`--motion-terminal-capsule`, ~280ms) rather than when it
 * ends — so a screenshot taken as soon as that attribute moves can catch the
 * capsule mid-growth. Two frames that agree is what "settled" means.
 */
async function fieldHeightAcrossFrame(field: Locator): Promise<[number, number]> {
  return field.evaluate(async (el) => {
    const before = el.getBoundingClientRect().height;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return [before, el.getBoundingClientRect().height];
  });
}


test.describe('App 375×812', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('No Session home', async ({ page }) => {
    await gotoFixtureApp(page, '?selection=none');
    await expect(page.getByTestId('app-home')).toBeVisible();

    await expect(page).toHaveScreenshot('app-home-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('app-sessions-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer, filtered', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    await page.getByPlaceholder('Search sessions...').fill('devbox');
    await expect(page.getByTestId('session-item-row')).toHaveCount(3);

    await expect(page).toHaveScreenshot('app-sessions-filtered-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer, degraded', async ({ page }) => {
    await gotoFixtureApp(page, '?stale=macbook');
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    await expect(page.getByText('Agent did not respond')).toHaveCount(2);
    await expect(page.getByText('Agent offline')).toHaveCount(1);

    await expect(page).toHaveScreenshot('app-sessions-degraded-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});

// #1083 criterion 15 names **844×390 landscape**, and it was the one viewport
// in that criterion with no picture: the structured assertions run there
// (`ui-contract-matrix`'s `app.landscape-phone`), but a measurement is not a
// photograph, and nothing would have failed if the screen stopped *reading*
// like a navigator while still passing every contract.
//
// It is also the viewport where the criterion that removed chrome is most
// visible: it has the least vertical room, so the Filters row, the Refresh
// button and the foot were the largest share of it. Measured before and after
// #1083, the list grew from 193px to 286px here.
