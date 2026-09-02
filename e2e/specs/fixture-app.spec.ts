// e2e/specs/fixture-app.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 390, height: 844 } });

test('canonical App fixture renders the spatial terminal page', async ({ page }) => {
  await page.goto('/#/fixture/app');

  await expect(page.getByTestId('session-first-shell')).toBeVisible();
  await expect(page.getByTestId('app-spatial-shell')).toBeVisible();

  // single-row header: sessions + workspace affordances, NO switcher, NO
  // duplicated floating buttons. Both pager pages stay mounted, so the
  // header line renders twice (terminal + workspace pages).
  await expect(page.getByTestId('session-header-line')).toHaveCount(2);
  await expect(page.getByTestId('session-header-line').first()).toBeVisible();
  await expect(page.getByTestId('app-header-sessions')).toBeVisible();
  await expect(page.getByTestId('app-header-workspace')).toBeVisible();
  await expect(page.getByTestId('surface-switcher')).toHaveCount(0);
  await expect(page.getByTestId('app-spatial-open-sessions')).toHaveCount(0);

  // terminal page is the centered pager page
  await expect(page.getByTestId('app-spatial-page-terminal')).toBeInViewport();

  await page.screenshot({ path: 'test-results/canonical-app-terminal.png', fullPage: true });
});

test('App workspace page shows the files plugin app layout', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  await expect(page.getByTestId('app-tool-header')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-app-workspace.png', fullPage: true });
});
