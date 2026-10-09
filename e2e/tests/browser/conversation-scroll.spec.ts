import { expect, test, type Locator } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux). CI-only, like every spec here.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * The scroll owner is scoped to a conversation, not to the surface (SC-20).
 *
 * ## What was wrong
 *
 * `#1414` keyed `TranscriptContent`, which resets everything that component
 * holds. But the tree is `Provider > Root > Viewport > Content`, and the
 * **provider** owns opening position, tail-follow, prepend anchoring and the
 * jump-to-bottom control. So a reader who scrolled away from the live edge in
 * one conversation carried that released follow into the next one, and
 * `defaultScrollPosition="end"` — applied at the provider's lifecycle — never
 * got a conversation to apply to. The same boundary as `#1414`, one owner up.
 *
 * ## Why this asserts the boundary and not the position
 *
 * The obvious assertion — scroll away, switch, expect the new conversation at
 * its end — **does not discriminate**, and that was measured rather than
 * assumed: with the provider key removed, the switch still lands at the end,
 * because the fixture answers the same transcript for both conversations and
 * the scroller re-pins when the content is replaced. A test that passes with the
 * fix removed asserts nothing.
 *
 * What does discriminate is the lifecycle itself, verified both ways in a
 * browser: mark the viewport, switch conversations, and look for the mark. With
 * the fix it is gone (a new node owns the scroll state); without it the mark
 * survives. So that is what is asserted.
 *
 * ## The complement matters as much
 *
 * A key coarser than the conversation — anything that changes on every item —
 * would pass the test above and break paging: a prepend is the one moment the
 * scroll position *must* survive, because the anchor the reader is holding is in
 * the items above. The second test is what makes the first one about the
 * conversation rather than about "something changed".
 */

/** Marks the current scroll owner so we can tell whether it was replaced. */
async function markScrollOwner(viewport: Locator, mark: string): Promise<void> {
  await viewport.evaluate((el, value) => {
    el.dataset.scrollOwnerProbe = value;
  }, mark);
}

async function scrollOwnerMark(viewport: Locator): Promise<string | null> {
  return viewport.evaluate((el) => el.dataset.scrollOwnerProbe ?? null);
}

test('a conversation switch hands the scroll state to a new owner', async ({ page }) => {
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=ready');

  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(viewport).toBeVisible();
  await markScrollOwner(viewport, 'first');

  // The fixture's `ready` corpus overflows the Web viewport, so this is a real
  // scroll surface rather than one that cannot move — measured, not assumed.
  const metrics = await viewport.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

  await page.getByRole('button', { name: /Capsule radius review/ }).click();
  await expect(page.getByTestId('conversation-open')).toContainText('Capsule radius review');

  // The new conversation gets its own scroll owner: opening position,
  // tail-follow, prepend anchoring and the jump-to-bottom control all belong to
  // the conversation the reader is in, not to the surface they are in.
  expect(await scrollOwnerMark(viewport)).toBeNull();
});

test('a prepend inside one conversation keeps the same owner', async ({ page }) => {
  // The other direction. Paging older history *must* preserve the scroll
  // position — the anchor lives in the rows above — so the key has to be the
  // conversation and nothing finer.
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=paged');

  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await expect(viewport).toBeVisible();
  await markScrollOwner(viewport, 'only');

  // Reaching the top is what asks for the older page.
  const rows = page.locator('[data-slot="message-scroller-item"]');
  const before = await rows.count();
  await viewport.evaluate((el) => {
    el.scrollTo({ top: 0 });
  });

  // The prepend has to actually happen, or the assertion below would be about
  // a scroll that changed nothing.
  await expect.poll(() => rows.count()).toBeGreaterThan(before);

  expect(await scrollOwnerMark(viewport)).toBe('only');
});
