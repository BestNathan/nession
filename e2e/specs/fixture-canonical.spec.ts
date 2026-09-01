// e2e/specs/fixture-canonical.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

test('canonical Active Terminal fixture renders the terminal-native shell', async ({ page }, testInfo) => {
  await page.goto('/#/fixture');

  await expect(page.getByTestId('session-first-shell')).toBeVisible();
  await expect(page.getByTestId('session-header-line')).toBeVisible();
  await expect(page.getByTestId('session-first-main-content')).toBeVisible();
  await expect(page.getByTestId('terminal-well')).toBeVisible();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect(page.locator('[data-testid="fixture-terminal"] .xterm canvas')).toBeVisible();

  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);

  await expect(page.getByTestId('server-connection')).toContainText('server: connected');

  await page.screenshot({ path: 'test-results/canonical-active-terminal.png', fullPage: true });

  await testInfo.attach('canonical-active-terminal', {
    path: 'test-results/canonical-active-terminal.png',
  });
});
