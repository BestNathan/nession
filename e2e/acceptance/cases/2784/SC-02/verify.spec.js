'use strict';
// #2784 SC-02: the Quick Commands surface shows its existing error/retry state
// for a server failed read, recovers through Retry into the correct ordered
// list, and keeps a genuinely empty successful list as ready/empty.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

/** Open the fixture app on a scenario and expand Quick Commands. */
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

test('SC-02: failed read → error/Retry → recovered list; empty success stays ready', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-02');

  await openCommands(page, 'recover');
  // The first read is the server's failed-read reply, not returned as empty.
  await expect(page.getByTestId('quick-commands-error')).toBeVisible();
  await expect(page.getByTestId('quick-commands-empty')).toHaveCount(0);
  await expect(page.getByTestId('quick-commands-retry')).toBeVisible();

  await page.getByTestId('quick-commands-retry').click();
  const list = page.getByTestId('quick-commands-list');
  await expect(list).toBeVisible({ timeout: 15_000 });
  // The server's order is preserved; no client-side sort or persistence.
  // Rows are named by their stable server ids, so this asserts identity and
  // order without repeating command text.
  const rows = await list
    .locator('[data-testid^="quick-command-fixture-"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')));
  expect(rows).toEqual([
    'quick-command-fixture-git-status',
    'quick-command-fixture-tests',
    'quick-command-fixture-tmux',
    'quick-command-fixture-pods',
    'quick-command-fixture-logs',
  ]);
  await expect(page.getByTestId('quick-commands-error')).toHaveCount(0);

  // Counterexample: an empty collection that loaded successfully is ready.
  await openCommands(page, 'none');
  await expect(page.getByTestId('quick-commands-empty')).toBeVisible();
  await expect(page.getByTestId('quick-commands-count')).toHaveText('0 commands');
  await expect(page.getByTestId('quick-commands-error')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a failed server read rendered the Quick Commands ' +
      'error/Retry state rather than the empty state; Retry then rendered the ' +
      'five server-ordered commands; commands=none rendered the ready empty list ' +
      '(0 commands) with no error',
  });
});
