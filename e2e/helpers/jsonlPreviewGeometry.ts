import { expect, type Page } from '@playwright/test';
import { gotoFixtureApp } from './fixtureVisual';

/** Must match `fixtureFiles.ts` heterogeneous JSONL tail lines. */
export const FIXTURE_JSONL_LONG_STRING_LINE = 111;
export const FIXTURE_JSONL_NESTED_LINE = 112;

export type JsonlRecordBox = { line: number; top: number; bottom: number };

function setsEqual(a: number[], b: number[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) {
    return false;
  }
  for (const line of sa) {
    if (!sb.has(line)) {
      return false;
    }
  }
  return true;
}

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

/** Rows mounted in the virtualizer that intersect the JSONL scrollport. */
export async function readVisibleJsonlRecordBoxes(page: Page): Promise<JsonlRecordBox[]> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="jsonl-preview-scroll"]');
    if (!host) {
      return [];
    }
    const hostRect = host.getBoundingClientRect();
    const intersectsHost = (rect: DOMRect) =>
      rect.height > 0 &&
      rect.bottom > hostRect.top + 1 &&
      rect.top < hostRect.bottom - 1;

    return Array.from(document.querySelectorAll('[data-jsonl-line]'))
      .map((el) => {
        const line = Number(el.getAttribute('data-jsonl-line'));
        const rect = el.getBoundingClientRect();
        return { line, top: rect.top, bottom: rect.bottom, height: rect.height };
      })
      .filter((row) => !Number.isNaN(row.line) && intersectsHost(row))
      .map(({ line, top, bottom }) => ({ line, top, bottom }));
  });
}

export async function scrollJsonlRecordIntoView(page: Page, lineNumber: number): Promise<void> {
  const scroll = page.getByTestId('jsonl-preview-scroll');
  const section = page.locator(`[data-jsonl-line="${lineNumber}"]`).first();

  await expect
    .poll(
      async () => {
        if ((await section.count()) === 0) {
          const metrics = await scroll.evaluate((el) => ({
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          }));
          if (metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 2) {
            return false;
          }
          await scroll.evaluate((el) => {
            el.scrollTop += Math.max(el.clientHeight * 0.75, 120);
          });
          return false;
        }
        await section.scrollIntoViewIfNeeded();
        return section.isVisible();
      },
      { timeout: 20_000, intervals: [50, 100, 200] },
    )
    .toBe(true);
}

export async function readJsonlRecordTop(page: Page, lineNumber: number): Promise<number> {
  await scrollJsonlRecordIntoView(page, lineNumber);
  const top = await page.locator(`[data-jsonl-line="${lineNumber}"]`).first().evaluate((el) => {
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
  await scrollJsonlRecordIntoView(page, 1);
  await expect(page.locator('[data-jsonl-line="1"]').first()).toBeVisible({ timeout: 10_000 });
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
  await scrollJsonlRecordIntoView(page, 1);
  await expect(page.locator('[data-jsonl-line="1"]').first()).toBeVisible({ timeout: 10_000 });
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
  await scrollJsonlRecordIntoView(page, lineNumber);
  const geometry = await page.locator(`[data-jsonl-line="${lineNumber}"]`).first().evaluate((root) => {
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

async function clickJsonlRecordToggle(
  page: Page,
  lineNumber: number,
  targetExpanded: boolean,
): Promise<void> {
  await scrollJsonlRecordIntoView(page, lineNumber);
  const section = page.locator(`[data-jsonl-line="${lineNumber}"]`).first();
  const label = targetExpanded ? 'Expand record' : 'Collapse record';
  const toggle = section.getByRole('button', { name: label });
  await toggle.waitFor({ state: 'visible', timeout: 10_000 });
  await toggle.click();
}

export async function expandJsonlRecord(page: Page, lineNumber: number): Promise<void> {
  await clickJsonlRecordToggle(page, lineNumber, true);
}

export async function collapseJsonlRecord(page: Page, lineNumber: number): Promise<void> {
  await clickJsonlRecordToggle(page, lineNumber, false);
}

export async function scrollJsonlPreview(page: Page, scrollTop: number): Promise<number> {
  return page.getByTestId('jsonl-preview-scroll').evaluate((el, top) => {
    el.scrollTop = top;
    return el.scrollTop;
  }, scrollTop);
}

export async function readJsonlScrollMetrics(page: Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}> {
  return page.getByTestId('jsonl-preview-scroll').evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
}

/**
 * Scroll until the set of lines intersecting the scrollport changes (#1199 review).
 */
export async function scrollJsonlUntilWindowChanges(page: Page): Promise<{
  beforeLines: number[];
  afterLines: number[];
  scrollTopBefore: number;
  scrollTopAfter: number;
}> {
  const beforeLines = await readVisibleJsonlLineNumbers(page);
  const { scrollTop: scrollTopBefore } = await readJsonlScrollMetrics(page);
  const scroll = page.getByTestId('jsonl-preview-scroll');

  let afterLines = beforeLines;
  let scrollTopAfter = scrollTopBefore;
  let moved = false;

  for (let step = 0; step < 12 && !moved; step++) {
    scrollTopAfter = await scroll.evaluate((el) => {
      el.scrollTop += Math.max(el.clientHeight * 0.85, 160);
      return el.scrollTop;
    });
    await page.waitForTimeout(100);
    afterLines = await readVisibleJsonlLineNumbers(page);
    moved = scrollTopAfter > scrollTopBefore && !setsEqual(beforeLines, afterLines);
  }

  expect(moved, 'JSONL virtual window should change after scrolling').toBe(true);
  expect(scrollTopAfter).toBeGreaterThan(scrollTopBefore);

  return { beforeLines, afterLines, scrollTopBefore, scrollTopAfter };
}
