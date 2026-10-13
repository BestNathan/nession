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


test.describe('Web compact 1024×768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('Active Terminal', async ({ page }) => {
    await gotoFixtureShell(page);
    await waitForFixtureTerminal(page);

    await expect(page).toHaveScreenshot('web-compact-terminal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Files', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await expect(page.getByTestId('files-web-layout')).toBeVisible();
    await openFixtureFile(page);

    await expect(page).toHaveScreenshot('web-compact-workspace.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});
