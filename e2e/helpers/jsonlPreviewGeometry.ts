import { expect, type Page } from '@playwright/test';

/** Visible JSONL record sections must not stack on top of each other (#1199). */
export async function assertVisibleJsonlRecordsDoNotOverlap(
  page: Page,
  tolerancePx = 2,
): Promise<void> {
  const lines = page.locator('[data-jsonl-line]');
  const count = await lines.count();
  const boxes: Array<{ top: number; bottom: number }> = [];
  for (let i = 0; i < count; i++) {
    const box = await lines.nth(i).boundingBox();
    if (box) {
      boxes.push({ top: box.y, bottom: box.y + box.height });
    }
  }
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
