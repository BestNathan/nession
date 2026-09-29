import { expect, type Page } from '@playwright/test';

/** Visible JSONL record sections must not stack on top of each other (#1199). */
export async function assertVisibleJsonlRecordsDoNotOverlap(
  page: Page,
  tolerancePx = 2,
): Promise<void> {
  // Every rect is read in **one** round trip, deliberately.
  //
  // The list is virtualized, so `[data-jsonl-line]` elements mount and unmount
  // as rows are measured — and expanding a record changes row heights, which
  // re-renders the window. Counting first and then reading `nth(i)` gives the
  // DOM a chance to move in between; when it does, that index resolves to zero
  // elements and `boundingBox()` *waits* for one to appear, which surfaced as
  // `locator.boundingBox: Test timeout of 30000ms exceeded` on this assertion
  // and nowhere else — an intermittent failure that looked like a flaky suite
  // (#1199). Reading the whole set atomically removes the window rather than
  // widening a timeout to hide it.
  const boxes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-jsonl-line]'))
      .map((el) => el.getBoundingClientRect())
      // `getBoundingClientRect` reports an all-zero rect for a hidden element,
      // which is how the previous `if (box)` guard excluded them.
      .filter((rect) => rect.height > 0)
      .map((rect) => ({ top: rect.top, bottom: rect.bottom })),
  );

  // Without this the overlap check below is vacuously true for an empty list —
  // a test that passes because it measured nothing.
  expect(boxes.length, 'no visible JSONL rows to compare').toBeGreaterThan(0);

  boxes.sort((a, b) => a.top - b.top);
  for (let i = 0; i < boxes.length - 1; i++) {
    expect(boxes[i].bottom).toBeLessThanOrEqual(boxes[i + 1].top + tolerancePx);
  }
}

export async function openFixtureJsonlEvents(page: Page): Promise<void> {
  for (const name of ['fixtures', 'events.jsonl']) {
    await page.getByRole('treeitem', { name }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('treeitem', { name }).click();
  }
  await expect(page.locator('[data-jsonl-line="1"]')).toBeVisible({ timeout: 10_000 });
}
