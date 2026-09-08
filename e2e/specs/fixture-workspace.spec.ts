// e2e/specs/fixture-workspace.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

test('canonical Workspace fixture renders the plugin shell', async ({ page }) => {
  await page.goto('/#/fixture/workspace');

  await expect(page.getByTestId('session-first-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  // tool bar from the registry: Files / Session / Agent
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Session' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Agent' })).toBeVisible();

  // files web layout renders tree ‖ editor
  await expect(page.getByTestId('files-web-layout')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-workspace.png', fullPage: true });
});

test('sessions drawer opens from the resting shell', async ({ page }) => {
  await page.goto('/#/fixture');
  await expect(page.getByTestId('session-drawer')).toBeVisible();
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});
