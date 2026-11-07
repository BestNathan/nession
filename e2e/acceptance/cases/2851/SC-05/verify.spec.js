'use strict';
// #2851 SC-05: Server status stays a separate dimension; Agent context is
// explicitly reachable and never becomes the Session hierarchy.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-05: offline Agents stay reachable without recoloring Server status', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
  await page.goto('/#/fixture?agents=offline');
  await page.reload();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.getByTestId('create-session')).toBeDisabled();
  await expect(page.getByTestId('sidebar-agents')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-server-status')).toHaveText('Server connected');
  await expect(page.getByTestId('sidebar-server-dot')).not.toHaveClass(/destructive/);
  await expect(page.getByTestId('session-item-devbox-01:fix-terminal-reconnect')).toContainText('Agent offline');

  const entry = page.getByTestId('sidebar-agents-entry');
  await expect(entry).toHaveAccessibleName(/3 agents, 0 online/);
  await entry.click();
  await expect(page.getByTestId('sidebar-agents-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-agents')).toBeVisible();
  await expect(page.getByTestId('sidebar-agent-sg-prod')).toBeVisible();
  await expect(page.getByTestId('sidebar-server-status')).toHaveText('Server connected');

  await page.goto('/#/fixture?connection=reconnecting');
  await page.reload();
  await expect(page.getByTestId('sidebar-server-status')).toHaveText('Server reconnecting');
  await expect(page.getByTestId('sidebar-server-dot')).toHaveClass(/destructive/);
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': with every Agent offline the Session rows remained and the Server mark stayed ' +
      'healthy; the lower Agents / locations entry announced 3 agents / 0 online and revealed the existing ' +
      'Agent rows; a reconnecting Server changed only the Server status mark, not the Session list',
  });
});
