// #561 Phase 7–8 / #548 — focused visual regression for canonical fixture routes.
// Functional assertions run first; screenshots are the drift gate afterward.
// Baseline update: CI=true npx playwright test fixture-visual --update-snapshots=all
import { expect, test } from '@playwright/test';
import {
  FIXTURE_SCREENSHOT,
  freezeFixtureClock,
  gotoFixtureApp,
  gotoFixtureShell,
  gotoFixtureWorkspace,
  openFixtureFile,
  waitForFixtureTerminal,
} from '../helpers/fixtureVisual';

test.skip(!process.env.CI, 'canonical visual regression runs in CI only');

test.beforeEach(async ({ page }) => {
  await freezeFixtureClock(page);
});

test.describe('Web 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Active Terminal', async ({ page }) => {
    await gotoFixtureShell(page);
    // Above `lg` the sidebar is a column, not an overlay drawer (#748). The
    // drawer-open screen this used to pin is not one the shipped shell has at
    // this width, so the canonical screenshot moves with the shell.
    await expect(page.getByTestId('session-first-sidebar-column')).toBeVisible();
    await expect(page.getByTestId('session-drawer')).toHaveCount(0);
    await waitForFixtureTerminal(page);
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('web-active-terminal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Files', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await expect(page.getByTestId('files-web-layout')).toBeVisible();
    // Open a file, so the viewer and the code surface are in the baseline
    // rather than an empty state that covers neither.
    await openFixtureFile(page);

    await expect(page).toHaveScreenshot('web-workspace.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});

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

test.describe('App 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Active Terminal', async ({ page }) => {
    await gotoFixtureApp(page);
    await expect(page.getByTestId('app-spatial-page-terminal')).toBeInViewport();
    await waitForFixtureTerminal(page);

    await expect(page).toHaveScreenshot('app-terminal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions spatial page', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-spatial-page-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('app-sessions.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Files', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').first().click();
    await expect(page.getByTestId('files-app-layout')).toBeVisible();
    // App pushes the viewer over the tree, so this captures the pushed editor
    // — which no baseline covered either.
    await openFixtureFile(page);

    await expect(page).toHaveScreenshot('app-workspace.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});
