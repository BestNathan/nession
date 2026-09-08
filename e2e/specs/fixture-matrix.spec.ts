// e2e/specs/fixture-matrix.spec.ts
// #561 Phase 6 — remaining canonical viewport matrix entries:
//   Web compact 1024×768 (Active Terminal + Workspace)
//   App Sessions 390×844
//
// Covered elsewhere:
//   fixture-canonical.spec.ts  — Web Active Terminal 1440×900
//   fixture-workspace.spec.ts  — Web Workspace 1440×900
//   fixture-app.spec.ts        — App Terminal + App Workspace 390×844
import { expect, test } from '@playwright/test';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.describe('Web compact 1024×768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('Active Terminal fixture renders at compact desktop width', async ({ page }, testInfo) => {
    await page.goto('/#/fixture');

    await expect(page.getByTestId('session-first-shell')).toBeVisible();
    await expect(page.getByTestId('session-drawer')).toBeVisible();
    await expect(page.getByTestId('terminal-well')).toBeVisible();
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await page.screenshot({ path: 'test-results/canonical-compact-terminal.png', fullPage: true });

    await testInfo.attach('canonical-compact-terminal', {
      path: 'test-results/canonical-compact-terminal.png',
    });
  });

  test('Workspace fixture renders at compact desktop width', async ({ page }, testInfo) => {
    await page.goto('/#/fixture/workspace');

    await expect(page.getByTestId('workspace-shell')).toBeVisible();
    await expect(page.getByTestId('files-web-layout')).toBeVisible();

    await page.screenshot({ path: 'test-results/canonical-compact-workspace.png', fullPage: true });

    await testInfo.attach('canonical-compact-workspace', {
      path: 'test-results/canonical-compact-workspace.png',
    });
  });
});

test.describe('App Sessions 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Sessions spatial page shows the flat session list', async ({ page }, testInfo) => {
    await page.goto('/#/fixture/app');
    await page.getByTestId('app-header-sessions').first().click();

    const sessionsPage = page.getByTestId('app-spatial-page-sessions');
    await expect(sessionsPage).toBeInViewport();
    await expect(page.getByTestId('session-first-sidebar')).toBeVisible();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);
    await expect(page.locator('[data-selected="true"]')).toHaveCount(1);

    await page.screenshot({ path: 'test-results/canonical-app-sessions.png', fullPage: true });

    await testInfo.attach('canonical-app-sessions', {
      path: 'test-results/canonical-app-sessions.png',
    });
  });
});
