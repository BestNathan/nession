import { expect, test, type Locator, type Page } from '@playwright/test';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

/**
 * The transcript is a complete raw-record browser (#3726).
 *
 * Two failures this file exists for:
 *
 * 1. **A record can be dropped.** A view that renders only the kinds its
 *    decoder understands turns an unknown type or a malformed line into a hole
 *    nobody can see. The fixture carries both, plus an oversized line, and the
 *    row count is the operand.
 * 2. **A large body can grow the pane instead of wrapping.** A tool body or a
 *    raw JSONL line routinely contains a run with no whitespace — base64, a
 *    long path, a minified line — and `overflow-wrap: break-word` does not
 *    reduce min-content, so the box grows. The shell clips, so a page-level
 *    overflow assertion passes while the body is unreadable past the pane edge.
 *    `wrap-anywhere` is counted in min-content, which is why the Raw text uses
 *    it.
 */

/** Open the session's own transcript and wait for its newest page. */
async function openPrimaryTranscript(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=claude-code');
  await expect(page.getByTestId('claude-code-workspace')).toBeVisible();

  await page.getByRole('tab', { name: 'Transcripts' }).click();

  // The session's own transcript — the second row, since the list puts the
  // subagents beside it rather than under it.
  await page.getByTestId('transcript-open').last().click();
  await expect(page.getByTestId('transcript-detail-view')).toBeVisible();
  await expect(page.getByTestId('transcript-record')).toHaveCount(4);
}

/** Open Raw for the fixture's oversized record, which the page did not carry. */
async function openOversizedRaw(page: Page): Promise<void> {
  await openPrimaryTranscript(page);

  const oversized = page
    .getByTestId('transcript-record')
    .filter({ hasText: 'open Raw' });
  await expect(oversized).toHaveCount(1);
  await oversized.getByTestId('transcript-raw-open').click();

  await expect(page.getByTestId('transcript-raw-inspector')).toBeVisible();
  await expect(page.getByTestId('transcript-raw-drawer')).toBeVisible();
  await page.getByRole('tab', { name: 'Original text' }).click();
  await expect(page.getByTestId('transcript-raw-text')).toBeVisible();
  // `complete` is the only state in which the view stops saying it is loading;
  // measuring a partial buffer would prove the wrong thing.
  await expect(page.getByTestId('transcript-raw-loading')).toHaveCount(0);
}

/** Widths are read on the box itself, which is the only place growth shows. */
async function widths(locator: Locator) {
  return locator.evaluate((el: HTMLElement) => ({
    width: Math.round(el.getBoundingClientRect().width),
    overflowX: el.scrollWidth - el.clientWidth,
  }));
}

test.describe('transcript raw records (#3726)', () => {
  test('every physical record is a row, and an older page preserves history', async ({
    page,
  }) => {
    await openPrimaryTranscript(page);

    // Unknown type, malformed JSON and the oversized placeholder all occupy a
    // row on the newest page. The labels are the record's own data, not a
    // parser-status badge.
    const rows = page.getByTestId('transcript-record');
    await expect(rows.filter({ hasText: 'new-runtime-diagnostic · probe' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'this line is not valid JSON' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'open Raw' })).toHaveCount(1);

    // No parser-state chips anywhere in the timeline.
    const timelineText = (await page.getByTestId('transcript-timeline').textContent()) ?? '';
    expect(timelineText.toLowerCase()).not.toContain('unrecognized');
    expect(timelineText.toLowerCase()).not.toContain('unknown record');

    await page.getByTestId('transcript-load-older').click();
    await expect(rows).toHaveCount(10);

    // Each source line appears once: the two pages cover ten distinct records.
    await expect(page.getByTestId('transcript-record-count')).toHaveText('10');
    await expect(
      rows.filter({ hasText: 'test result: ok. 399 passed; 0 failed' }),
    ).toHaveCount(1);
    await expect(rows.filter({ hasText: 'hook_success' })).toHaveCount(1);

    // A live poll re-reads the newest page. It must not duplicate or reorder
    // the history the reader already loaded.
    await page.waitForTimeout(3500);
    await expect(rows).toHaveCount(10);
  });

  test('an unbroken raw body wraps inside its bounded inspector', async ({ page }) => {
    await openOversizedRaw(page);

    const pane = await widths(page.getByTestId('transcript-detail-view'));
    const timeline = await widths(page.getByTestId('transcript-timeline'));
    const inspector = await widths(page.getByTestId('transcript-raw-inspector'));
    const body = await widths(page.getByTestId('transcript-raw-text'));

    // The operand first: the body actually carries a run that cannot break on
    // whitespace. Without this the rest of the test would pass on a stub.
    const longestRun = await page
      .getByTestId('transcript-raw-text')
      .evaluate((el: HTMLElement) =>
        Math.max(...(el.textContent ?? '').split(/\s+/).map((s) => s.length)),
      );
    expect(longestRun, 'no unbroken run in the raw body').toBeGreaterThan(200);

    // Growth is the failure; clipping would hide it from a page-level check.
    expect(timeline.width, 'timeline grew past its pane').toBeLessThanOrEqual(pane.width);
    expect(inspector.width, 'inspector grew past its pane').toBeLessThanOrEqual(pane.width);
    expect(body.width, 'raw body grew past its pane').toBeLessThanOrEqual(pane.width);

    // The Web inspector is an overlay: the timeline keeps its width behind it.
    expect(timeline.width, 'the drawer permanently shrank the timeline').toBe(pane.width);

    // Wrapping is the strategy, so nothing scrolls sideways.
    expect(body.overflowX, 'raw body scrolls horizontally').toBeLessThanOrEqual(1);
    expect(inspector.overflowX, 'inspector scrolls horizontally').toBeLessThanOrEqual(1);
    expect(timeline.overflowX, 'timeline scrolls horizontally').toBeLessThanOrEqual(1);
  });

  test('the page itself does not scroll sideways with Raw open', async ({ page }) => {
    await openOversizedRaw(page);

    // Asserted alongside the box check rather than instead of it: this is the
    // one that stays green while the body is unreadable, so it is the weaker
    // half of the pair and not evidence on its own.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });
});

/**
 * App: one pushed record depth, one Back.
 *
 * At 390 and 375 the surface must not compress the Web split into a phone
 * width. A row taps into a pushed depth; Raw lives inside that same depth, so
 * there is never a second Back competing with the host's.
 */
test.describe('transcript raw records on App (#3726)', () => {
  for (const width of [390, 375]) {
    test(`record depth and Raw stay within ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').click();
      await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
      await page.getByTestId('workspace-tool-claude-code').click();
      await expect(page.getByTestId('claude-code-workspace')).toBeVisible();

      await page.getByRole('tab', { name: 'Transcripts' }).click();
      await page.getByTestId('transcript-open').last().click();
      await expect(page.getByTestId('transcript-record')).toHaveCount(4);
      await expect(page.getByTestId('transcript-layout')).toHaveText('push');

      const first = page.getByTestId('transcript-record').first();
      await first.getByTestId('transcript-record-open').click();

      // A pushed depth, not a shrunken master-detail: the transcript-level Back
      // is gone, and there is exactly one Back for the record.
      await expect(page.getByTestId('transcript-record-push')).toBeVisible();
      await expect(page.getByTestId('transcript-back')).toHaveCount(0);
      await expect(page.getByTestId('transcript-record-back')).toHaveCount(1);

      // Raw is inside the same depth, not a second overlay with its own leave.
      await page.getByTestId('transcript-raw-open').click();
      await expect(page.getByTestId('transcript-raw-inspector')).toBeVisible();
      await expect(page.getByTestId('transcript-raw-inspector')).toHaveAttribute(
        'data-variant',
        'pushed',
      );
      await expect(page.getByTestId('transcript-raw-close')).toHaveCount(0);
      await expect(page.getByTestId('transcript-record-back')).toHaveCount(1);

      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(pageOverflow).toBeLessThanOrEqual(1);

      await page.getByTestId('transcript-record-back').click();
      await expect(page.getByTestId('transcript-record-push')).toHaveCount(0);
      await expect(page.getByTestId('transcript-record')).toHaveCount(4);
    });
  }
});
