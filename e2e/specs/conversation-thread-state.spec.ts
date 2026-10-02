import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux). CI-only, like every spec here.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * The thread states a provider can answer with, driven in a browser.
 *
 * ## Why this file exists
 *
 * `#1363`'s round-2 review named three paths it could not falsify because no
 * browser walked them, and this is the first of them: a **thread** the provider
 * could not read. The state had an arm (`#1397`) and unit coverage, but the only
 * `unavailable` scenario the fixture had meant *the directory could not be
 * listed* — a different screen. So the arm had never been rendered outside jsdom.
 *
 * A unit test proves the component branches. It cannot prove the fixture can
 * reach the state, that the route wires it, or that the real surface puts it on
 * screen — and the review's point was that "no browser could show this" is not
 * the same as "this works".
 *
 * ## What it asserts, and the one it deliberately does not
 *
 * The absence assertions are the load-bearing ones. `conversation-empty` says
 * "This conversation has no messages yet" — a claim about the conversation's
 * contents that a provider answering `unavailable` explicitly did not make.
 * Asserting only that the unavailable row appears would pass on a surface that
 * rendered *both*.
 */

test('an unreadable thread says so rather than claiming to be empty', async ({ page }) => {
  // The list reads fine; only the messages unit cannot answer. That pairing is
  // the state — `unavailable` on the *list* is a different screen, and it is the
  // one the fixture could already reach.
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=thread-unavailable');

  await expect(page.getByTestId('claude-code-workspace')).toBeVisible();

  const notice = page.getByTestId('conversation-unavailable');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('cannot be read');

  // The two sentences that must not appear. `conversation-empty` is the one
  // this whole state exists to keep apart; `conversation-missing` is the other
  // neighbour it is easy to collapse into.
  await expect(page.getByTestId('conversation-empty')).toHaveCount(0);
  await expect(page.getByTestId('conversation-missing')).toHaveCount(0);
});

test('the unreadable thread offers a way to ask again', async ({ page }) => {
  // Load-bearing rather than decorative: the runtime stops refreshing on a
  // non-ready answer, so this is the one degraded state a reader cannot wait
  // their way out of. Without the control it is a dead end only a reload leaves.
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=thread-unavailable');

  const notice = page.getByTestId('conversation-unavailable');
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
});
