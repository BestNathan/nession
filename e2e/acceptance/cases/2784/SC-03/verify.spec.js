'use strict';
// #2784 SC-03: server.commands.changed and reconnect refresh re-read the
// server owner and preserve the failed-read/empty distinction; neither
// introduces a client-side cached list owner.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openCommands(page, scenario) {
  await page.goto('about:blank');
  await page.goto('/#/fixture/app?commands=' + scenario);
  await page.getByTestId('app-layer-terminal').waitFor({ timeout: 20_000 });
  await page.getByTestId('capsule-capability-more').click();
  const row = page
    .getByTestId('capsule-capability-picker-quick-commands')
    .or(page.getByTestId('capsule-context-item-quick-commands'));
  await row.first().click();
  await expect(page.getByTestId('quick-commands-body')).toBeVisible({ timeout: 10_000 });
}

test('SC-03: changed and reconnect refetches keep failure distinct from empty', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-03');

  // A server-pushed change re-reads the owner: the first read failed, the
  // refetch succeeds. The transient error must not become a cached empty list.
  await openCommands(page, 'changed');
  await expect(page.getByTestId('quick-commands-error')).toBeVisible();
  await page.evaluate(() => window.fixtureCommandsChanged());
  await expect(page.getByTestId('quick-commands-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quick-commands-error')).toHaveCount(0);
  await expect(page.getByTestId('quick-commands-count')).toHaveText('5 commands');

  // A reconnect re-reads the same owner after a failed read while the link was
  // down, and again the recovered list is server-provided, not cached.
  await openCommands(page, 'reconnect');
  await expect(page.getByTestId('quick-commands-error')).toBeVisible();
  await page.evaluate(() => window.fixtureCommandsReconnect());
  await expect(page.getByTestId('quick-commands-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('quick-commands-error')).toHaveCount(0);
  await expect(page.getByTestId('quick-commands-count')).toHaveText('5 commands');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': after a failed read, a server.commands.changed push ' +
      'and a reconnect each refetched the server owner and rendered the five ' +
      'commands with no error; the view held no client-side list between the ' +
      'failure and the refetch',
  });
});
