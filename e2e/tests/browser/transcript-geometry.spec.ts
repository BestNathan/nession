import { expect, test, type Locator, type Page } from '@playwright/test';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

/**
 * The transcript detail must wrap, not grow (#1234).
 *
 * This exists because the failure is invisible to every other kind of check. A
 * tool body, an attachment payload or a reasoning block routinely contains a
 * run with no whitespace in it — base64, a long path, a minified line — and a
 * box that cannot break inside it does not overflow the *page*: the shell
 * clips, so `document.scrollWidth` stays equal to the viewport and a
 * page-level overflow assertion passes while the body is unreadable past the
 * pane edge.
 *
 * So the operand measured here is the box, not the page. Before the fix,
 * measured in a browser on this same fixture: the detail body was 5980px wide
 * with an 864-character unbroken run, which grew the timeline to 6004px inside
 * a 992px pane, with `document.body.scrollWidth - clientWidth === 0` the whole
 * time. After it: body 968px, timeline 992px, no horizontal scroll anywhere.
 *
 * `overflow-wrap: break-word` (`break-words`) does not fix this and looks like
 * it should: by spec it is *not* counted in an element's min-content size, so
 * the flex item is floored at its unbroken content and the box grows instead of
 * wrapping. `anywhere` is counted, which is why the class is `wrap-anywhere`.
 */

/** Open the transcript whose fixture body is cut at the ceiling. */
async function openCutTranscript(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=claude-code');
  await expect(page.getByTestId('claude-code-workspace')).toBeVisible();

  await page.getByRole('tab', { name: 'Transcripts' }).click();

  // The session's own transcript — the second row, since the list puts the
  // subagents beside it rather than under it.
  await page.getByTestId('transcript-open').last().click();
  await expect(page.getByTestId('transcript-detail-view')).toBeVisible();

  // The cut body is behind disclosure, by design: collapsed is a reading
  // posture, and this asserts about the body, so it is opened.
  await page
    .getByTestId('transcript-item')
    .filter({ hasText: 'truncated' })
    .first()
    .getByRole('button')
    .click();
  await expect(page.getByTestId('transcript-detail')).toBeVisible();
}

/** Widths are read on the box itself, which is the only place the growth shows. */
async function widths(locator: Locator) {
  return locator.evaluate((el: HTMLElement) => ({
    width: Math.round(el.getBoundingClientRect().width),
    overflowX: el.scrollWidth - el.clientWidth,
  }));
}

test.describe('transcript detail geometry (#1234)', () => {
  test('an unbroken body wraps inside its pane instead of growing the timeline', async ({ page }) => {
    await openCutTranscript(page);

    const pane = await widths(page.getByTestId('transcript-detail-view'));
    const timeline = await widths(page.getByTestId('transcript-timeline'));
    const body = await widths(page.getByTestId('transcript-detail'));

    // The operand first: the body actually carries a run that cannot break on
    // whitespace. Without this the rest of the test would pass on a fixture
    // that had quietly shrunk back to a stub, which is exactly what it did
    // before — the body was 12 characters and proved nothing.
    const longestRun = await page
      .getByTestId('transcript-detail')
      .evaluate((el: HTMLElement) => Math.max(...(el.textContent ?? '').split(/\s+/).map((s) => s.length)));
    expect(longestRun, 'no unbroken run in the body — the assertion below cannot fail').toBeGreaterThan(200);

    // Growth is the failure; clipping would hide it from a page-level check.
    expect(timeline.width, 'timeline grew past its pane').toBeLessThanOrEqual(pane.width);
    expect(body.width, 'detail body grew past its pane').toBeLessThanOrEqual(pane.width);

    // Wrapping is the strategy, so nothing scrolls sideways — not the body and
    // not the region that owns the scroll.
    expect(body.overflowX, 'detail body scrolls horizontally').toBeLessThanOrEqual(1);
    expect(timeline.overflowX, 'timeline scrolls horizontally').toBeLessThanOrEqual(1);
  });

  test('the page itself does not scroll sideways with a cut body open', async ({ page }) => {
    await openCutTranscript(page);

    // Asserted alongside the box check rather than instead of it: this is the
    // one that stays green while the body is unreadable, so it is recorded as
    // the weaker half of the pair and not as evidence on its own.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });
});
