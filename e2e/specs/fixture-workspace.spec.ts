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

  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  // Contextual chrome: the opened capability holds the direct slot, and
  // registration no longer produces a permanent navigation item.
  await expect(page.getByTestId('workspace-tool-files')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-agent')).toHaveCount(0);

  // files web layout renders tree ‖ editor
  await expect(page.getByTestId('files-web-layout')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-workspace.png', fullPage: true });

  // Everything else available is progressively disclosed through More.
  await page.getByTestId('workspace-capability-capsule').click();
  await expect(page.getByTestId('workspace-capability-picker-agent')).toBeVisible();
  await expect(page.getByTestId('workspace-capability-picker-session')).toBeVisible();
});

test('the Terminal destination action sits left of the capability dock (#1204)', async ({ page }) => {
  await page.goto('/#/fixture/workspace');

  const action = page.getByTestId('surface-action-open-terminal');
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute('aria-label', 'Open Terminal');

  // Two adjacent but separate navigations: the circle lives in surface
  // navigation, not in the capability dock.
  await expect(
    page.getByTestId('workspace-surface-navigation').getByTestId('surface-action-open-terminal'),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace capabilities' })
      .getByTestId('surface-action-open-terminal'),
  ).toHaveCount(0);

  // The retired top-right switcher is gone from this surface too.
  await expect(page.getByTestId('surface-switcher')).toHaveCount(0);

  const actionBox = await action.boundingBox();
  const dockBox = await page
    .getByRole('navigation', { name: 'Workspace capabilities' })
    .boundingBox();
  expect(actionBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  if (!actionBox || !dockBox) {
    return;
  }

  // Immediately left of the dock, vertically centered against it.
  const gap = dockBox.x - (actionBox.x + actionBox.width);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThanOrEqual(16);
  const actionCenter = actionBox.y + actionBox.height / 2;
  expect(Math.abs(actionCenter - (dockBox.y + dockBox.height / 2))).toBeLessThanOrEqual(8);
  expect(Math.abs(actionBox.height - dockBox.height)).toBeLessThanOrEqual(1);
});

test('the sessions sidebar is present in the resting shell', async ({ page }) => {
  await page.goto('/#/fixture');
  // Above `lg` the sidebar is a column, not an overlay drawer (#748): there is
  // nothing to "open", and the drawer state no longer exists at this width.
  await expect(page.getByTestId('sidebar-column')).toBeVisible();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});
