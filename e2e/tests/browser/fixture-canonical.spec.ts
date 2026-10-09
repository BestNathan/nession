// e2e/tests/browser/fixture-canonical.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

test('canonical Active Terminal fixture renders the terminal-native shell', async ({ page }, testInfo) => {
  await page.goto('/#/fixture');

  await expect(page.getByTestId('shell')).toBeVisible();
  // Web has no Session header at all since #748: the canonical wide screen is
  // two columns, and Session identity is the selected row in the sidebar.
  await expect(page.getByTestId('session-header-line')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-column')).toBeVisible();
  await expect(page.getByTestId('main-content')).toBeVisible();
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

test('the Workspace destination action sits beside the capsule and covers no terminal content (#1204)', async ({
  page,
}) => {
  await page.goto('/#/fixture');

  const action = page.getByTestId('surface-action-open-workspace');
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute('aria-label', 'Open Workspace');

  // The retired two-state control left nothing behind — least of all an
  // overlay pinned to the work surface's top-right corner.
  await expect(page.getByTestId('surface-switcher')).toHaveCount(0);

  const shellBox = await page.getByTestId('capsule-shell').boundingBox();
  const actionBox = await action.boundingBox();
  expect(shellBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  if (!shellBox || !actionBox) {
    return;
  }

  // Adjacent to the capsule's right edge, separated only by the group gap.
  const gap = actionBox.x - (shellBox.x + shellBox.width);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThanOrEqual(16);

  // Same band as the capsule shell: bottom-aligned and equal height so the row
  // reads as one piece of chrome (#1204).
  expect(actionBox.y).toBeGreaterThanOrEqual(shellBox.y - 1);
  expect(Math.abs(actionBox.y + actionBox.height - (shellBox.y + shellBox.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(actionBox.height - shellBox.height)).toBeLessThanOrEqual(1);

  // Circular destination control.
  expect(actionBox.width).toBe(actionBox.height);
});
