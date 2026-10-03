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
 *
 * ## The second path: a Turn's two phases
 *
 * Round 4 named a gate that could not tell "folds correctly" from "never folds":
 * the App walk asserted the fold against a transcript whose Turn never settles,
 * so the assertion could only ever have been passing for the wrong reason or
 * failing for the right one. The two tests at the bottom of this file are the
 * pair that fixes it — the same control, two corpora, opposite states — and
 * they are here rather than in the visual walk because a phase is a behaviour,
 * not a picture. Neither takes a screenshot, so neither owns a baseline.
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

test('a settled Turn folds its work, and the control opens it again', async ({ page }) => {
  // The `settled` corpus is the fixture's only Turn that *can* fold: its tools
  // have all finished and its last item is the assistant's answer. Asserting
  // the closure here is asserting the phase, not an element.
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=settled');

  await expect(page.getByTestId('claude-code-workspace')).toBeVisible();

  const control = page.getByTestId('conversation-turn-process').first();
  await expect(control).toBeVisible();
  // The label is the same line in both phases ("Worked for 3m" here, "Worked
  // for 6m30s" on `ready`), so it proves this is the work line and nothing
  // more. The phase lives in `aria-expanded`, and deliberately not in copy:
  // the two corpora differ by state, not by wording.
  await expect(control).toContainText('Worked');
  await expect(control).toHaveAttribute('aria-expanded', 'false');

  // Folded means hidden, not unmounted: the rows keep their place in the flat
  // list so their scroll anchors and group identities survive (#1386). Both
  // halves are asserted, because `toBeHidden()` on its own passes just as well
  // on a component that threw the row away — which is the bug, not the rule.
  const firstTool = page.getByTestId('conversation-tool').first();
  await expect(firstTool).toHaveCount(1);
  await expect(firstTool).toBeHidden();

  await control.click();

  await expect(control).toHaveAttribute('aria-expanded', 'true');
  await expect(firstTool).toBeVisible();
});

test('a working Turn does not fold, and says so before anyone clicks', async ({ page }) => {
  // The `ready` corpus ends in running work, so after #1409 it is a Turn that
  // has not settled — the answer is the last assistant message no work follows,
  // and work does follow. Its process is open *by state*, with no gesture and
  // no screenshot to make it so.
  //
  // Without this half the pair is only half a gate: a surface that never folds
  // would satisfy the test above by opening on click, and one that always folds
  // would satisfy this one by accident. Together they pin the phase as the
  // thing the control follows.
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=ready');

  const control = page.getByTestId('conversation-turn-process').first();
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('aria-expanded', 'true');

  // Not merely expanded — the work is on screen without a click.
  await expect(page.getByTestId('conversation-tool').first()).toBeVisible();
});
