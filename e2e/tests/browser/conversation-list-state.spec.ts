import { expect, test } from '@playwright/test';
import { gotoFixtureApp } from '../../helpers/fixtureVisual';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux). CI-only, like every spec here.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * A list refresh that failed over rows the reader can still see.
 *
 * ## Why this needs a route of its own
 *
 * `ListStateGuard` reports a list failure only when there is nothing to choose
 * from, which is right for its job and wrong for this state: the reader has
 * rows, the refresh missed, and `listError` was populated and drawn nowhere at
 * all (`#1363` round 4). The two screens are not interchangeable — one replaces
 * the list, the other must not — so the second needs its own input, and the
 * fixture's `list-stale` is it.
 *
 * ## Why the thread is unreadable in this scenario
 *
 * Not atmosphere. The only control in this surface that reloads *both* halves
 * is the Retry a non-ready thread offers, so without it the list refresh could
 * not be asked for at all and the state would have no path to it.
 *
 * Verified in a browser before being written, not derived from the markup.
 */

test('a failed list refresh keeps its rows and says it failed', async ({ page }) => {
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=list-stale');

  const rows = page.getByTestId('conversation-candidate-title');
  await expect(rows.first()).toBeVisible();
  // The state being reached is a *refresh* failing, so the first read must have
  // worked: a browser that starts here would be testing the guard's screen.
  await expect(page.getByTestId('conversation-list-error')).toHaveCount(0);

  // The thread's own failure carries the one control that reloads both halves.
  const retry = page
    .getByTestId('conversation-unavailable')
    .getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();
  await retry.click();

  const notice = page.getByTestId('conversation-list-error');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('could not be listed');

  // The load-bearing half: the rows are still there. A surface that replaced
  // them with the failure would be the guard's screen, which the assertion
  // above it already rules out.
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toBeVisible();
});


test.describe('App push composition', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a failed list refresh keeps the same warning and stale rows', async ({ page }) => {
    await gotoFixtureApp(page, '?conversation=list-stale');
    await page.getByTestId('app-header-workspace').first().click();
    await page.getByTestId('workspace-tool-claude-code').click();

    const retry = page
      .getByTestId('conversation-unavailable')
      .getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await retry.click();

    // Push starts on the open thread. Enter the list through the same control a
    // reader uses; the warning must not be a Web/master-detail-only semantic.
    await page.getByTestId('conversation-show-list').click();

    const notice = page.getByTestId('conversation-list-error');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('could not be listed');

    const rows = page.getByTestId('conversation-candidate-title');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toBeVisible();
  });
});
