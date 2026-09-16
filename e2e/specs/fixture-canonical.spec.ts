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
  // Web has no Session header at all since #748: the canonical wide screen is
  // two columns, and Session identity is the selected row in the sidebar.
  await expect(page.getByTestId('session-header-line')).toHaveCount(0);
  await expect(page.getByTestId('session-first-sidebar-column')).toBeVisible();
  await expect(page.getByTestId('session-first-main-content')).toBeVisible();
  await expect(page.getByTestId('terminal-well')).toBeVisible();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  // Renderer-agnostic: headless xterm may use the DOM renderer (no canvas).
  await expect(page.locator('[data-testid="fixture-terminal"] .xterm-screen')).toBeVisible();

  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);

  // Healthy canonical state: identity + navigation only. Infrastructure
  // members appear as they degrade. Agent reachability lives on the affected
  // Session row; attachment state on the sidebar footer.
  await expect(page.getByTestId('agent-context')).toHaveCount(0);
  await expect(page.getByTestId('connection-status')).toHaveCount(0);
  await expect(page.getByTestId('server-connection')).toHaveCount(0);

  await page.screenshot({ path: 'test-results/canonical-active-terminal.png', fullPage: true });

  await testInfo.attach('canonical-active-terminal', {
    path: 'test-results/canonical-active-terminal.png',
  });
});
