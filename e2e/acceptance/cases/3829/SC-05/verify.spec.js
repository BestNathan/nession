'use strict';
// #3829 SC-05: the App composition reuses the shared conversation/transcript/
// memory/MCP/configuration owners, and Web's master/detail presentation is not
// regressed. This browser half proves both compositions render the shared
// reader in the shipped build and the App does not surface a provider UUID.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openClaudeApp } = require('../../../shared/claude-app-browser.cjs');

test('SC-05: Web keeps its master/detail and both surfaces share the conversation reader', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-05');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=claude-code');
  await page.getByTestId('workspace-shell').waitFor({ timeout: 30_000 });
  await expect(page.getByTestId('claude-code-view-tabs')).toBeVisible();
  await expect(page.getByTestId('claude-code-view-tabs').getByRole('tab')).toHaveCount(5);
  // Web's composition is still the wide master/detail, not the App stack.
  await expect(page.getByTestId('conversation-master-detail')).toBeVisible();
  await expect(page.getByTestId('conversation-open')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Claude Code' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await openClaudeApp(page);
  const appRoot = page.getByTestId('claude-app-root');
  await expect(appRoot).toBeVisible();
  await expect(page.getByTestId('conversation-open')).toBeVisible();
  await expect(page.getByTestId('conversation-open')).not.toContainText('c0a1b2c3-');
  await expect(page.getByTestId('claude-code-view-tabs')).toHaveCount(0);
  // The App root draws the same shared transcript rows as Web, not a second
  // App-only conversation renderer.
  await expect(page.getByTestId('conversation-turn').first()).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web still rendered the five-tab master/detail ' +
      'Claude Workspace, while App rendered the conversation-first stack with the ' +
      'shared conversation-turn rows and no provider UUID. Both surfaces were ' +
      'produced by the same shipped build.',
  });
});
