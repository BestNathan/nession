import { expect, type Page } from '@playwright/test';
import { gotoFixtureApp } from './fixtureVisual';

/** Must match `fixtureFiles.ts` heterogeneous JSONL tail lines. */
export const FIXTURE_JSONL_LONG_STRING_LINE = 111;
export const FIXTURE_JSONL_NESTED_LINE = 112;

export type JsonlRecordBox = { line: number; top: number; bottom: number };

/** Visible JSONL record sections must not stack on top of each other (#1199). */
export async function assertVisibleJsonlRecordsDoNotOverlap(
  page: Page,
  tolerancePx = 2,
): Promise<void> {
  const boxes = await readVisibleJsonlRecordBoxes(page);

  expect(boxes.length, 'no visible JSONL rows to compare').toBeGreaterThan(0);

  boxes.sort((a, b) => a.top - b.top);
  for (let i = 0; i < boxes.length - 1; i++) {
    expect(boxes[i].bottom).toBeLessThanOrEqual(boxes[i + 1].top + tolerancePx);
  }
}

export async function readVisibleJsonlLineNumbers(page: Page): Promise<number[]> {
  const boxes = await readVisibleJsonlRecordBoxes(page);
  return boxes.map((b) => b.line);
}

export async function readVisibleJsonlRecordBoxes(page: Page): Promise<JsonlRecordBox[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-jsonl-line]'))
      .map((el) => {
        const line = Number(el.getAttribute('data-jsonl-line'));
        const rect = el.getBoundingClientRect();
        return { line, top: rect.top, bottom: rect.bottom, height: rect.height };
      })
      .filter((row) => row.height > 0 && !Number.isNaN(row.line))
      .map(({ line, top, bottom }) => ({ line, top, bottom })),
  );
}

export async function readJsonlRecordTop(page: Page, lineNumber: number): Promise<number> {
  const top = await page.locator(`[data-jsonl-line="${lineNumber}"]`).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.height > 0 ? rect.top : null;
  });
  expect(top, `line ${lineNumber} must be visible`).not.toBeNull();
  return top as number;
}

export async function openFixtureJsonlEventsWeb(page: Page): Promise<void> {
  for (const name of ['fixtures', 'events.jsonl']) {
    await page.getByRole('treeitem', { name }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('treeitem', { name }).click();
  }
  await expect(page.locator('[data-jsonl-line="1"]')).toBeVisible({ timeout: 10_000 });
}

/** App Files navigator → pushed viewer (#1199 acceptance). */
export async function openFixtureJsonlEventsApp(page: Page): Promise<void> {
  await gotoFixtureApp(page);
  await page.getByTestId('app-header-workspace').click();
  for (const segment of ['fixtures', 'fixtures/events.jsonl']) {
    const row = page.getByTestId(`file-row-${segment}`);
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
  }
  await expect(page.locator('[data-jsonl-line="1"]')).toBeVisible({ timeout: 10_000 });
}

/** @deprecated use openFixtureJsonlEventsWeb */
export const openFixtureJsonlEvents = openFixtureJsonlEventsWeb;

/**
 * Inspector key | : | value — colon stays with key; value wraps in its column (#1199).
 */
export async function assertInspectorKeyColonShareRowWithValue(
  page: Page,
  lineNumber: number,
): Promise<void> {
  const geometry = await page.locator(`[data-jsonl-line="${lineNumber}"]`).evaluate((root) => {
    const row = root.querySelector('[role="treeitem"]');
    if (!row || row.children.length < 3) {
      return null;
    }
    const [keyEl, colonEl, valueEl] = Array.from(row.children) as HTMLElement[];
    const key = keyEl.getBoundingClientRect();
    const colon = colonEl.getBoundingClientRect();
    const value = valueEl.getBoundingClientRect();
    return { key, colon, value };
  });
  expect(geometry, 'expected an inspector key/value row').not.toBeNull();
  const { key, colon, value } = geometry as NonNullable<typeof geometry>;
  expect(Math.abs(key.top - colon.top)).toBeLessThanOrEqual(4);
  expect(value.top).toBeLessThanOrEqual(key.bottom + 4);
  expect(value.top).toBeGreaterThanOrEqual(key.top - 4);
}

export async function expandJsonlRecord(page: Page, lineNumber: number): Promise<void> {
  const section = page.locator(`[data-jsonl-line="${lineNumber}"]`);
  await section.getByRole('button', { name: 'Expand record' }).click();
}

export async function scrollJsonlPreview(page: Page, scrollTop: number): Promise<number> {
  return page.getByTestId('jsonl-preview-scroll').evaluate((el, top) => {
    el.scrollTop = top;
    return el.scrollTop;
  }, scrollTop);
}

export async function readJsonlScrollMetrics(page: Page): Promise<{ scrollTop: number; scrollHeight: number }> {
  return page.getByTestId('jsonl-preview-scroll').evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
  }));
}
