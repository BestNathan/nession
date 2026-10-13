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


test.describe('App 844×390 landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('Sessions layer', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    // The list keeps its floor and stays reachable — the #1057 crisis, which
    // this viewport is the canonical case for. Asserted as well as
    // photographed, because a full-page screenshot of a short viewport cannot
    // show that a scrollable region inside it has height.
    const list = page.getByTestId('app-sessions-list');
    await expect(list).toBeVisible();
    expect((await list.boundingBox())?.height ?? 0).toBeGreaterThan(100);

    await expect(page).toHaveScreenshot('app-sessions-844x390.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});
