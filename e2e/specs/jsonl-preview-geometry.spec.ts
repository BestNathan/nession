import { expect, test } from '@playwright/test';
import {
  assertInspectorKeyColonShareRowWithValue,
  assertVisibleJsonlRecordsDoNotOverlap,
  expandJsonlRecord,
  FIXTURE_JSONL_LONG_STRING_LINE,
  FIXTURE_JSONL_NESTED_LINE,
  openFixtureJsonlEventsApp,
  openFixtureJsonlEventsWeb,
  readJsonlRecordTop,
  readJsonlScrollMetrics,
  readVisibleJsonlLineNumbers,
  scrollJsonlPreview,
} from '../helpers/jsonlPreviewGeometry';
import { gotoFixtureWorkspace } from '../helpers/fixtureVisual';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.describe('JSONL preview geometry (#1199)', () => {
  test('virtual rows do not overlap while scrolling (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    const beforeLines = await readVisibleJsonlLineNumbers(page);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    const { scrollHeight } = await readJsonlScrollMetrics(page);
    const appliedScrollTop = await scrollJsonlPreview(page, scrollHeight / 3);
    expect(appliedScrollTop).toBeGreaterThan(0);

    const afterLines = await readVisibleJsonlLineNumbers(page);
    expect(new Set(afterLines)).not.toEqual(new Set(beforeLines));

    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    await scrollJsonlPreview(page, (scrollHeight * 2) / 3);
    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('expand/collapse repositions following rows (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    const nextLine = 2;
    const nextTopBefore = await readJsonlRecordTop(page, nextLine);

    await expandJsonlRecord(page, 1);
    await page.waitForTimeout(150);
    const nextTopExpanded = await readJsonlRecordTop(page, nextLine);
    expect(nextTopExpanded).toBeGreaterThan(nextTopBefore);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    await expandJsonlRecord(page, 1);
    await page.waitForTimeout(150);
    const nextTopCollapsed = await readJsonlRecordTop(page, nextLine);
    expect(nextTopCollapsed).toBeLessThanOrEqual(nextTopExpanded);
    expect(nextTopCollapsed).toBeLessThanOrEqual(nextTopBefore + 4);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('heterogeneous records survive nested disclosure and scroll-back (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    await expandJsonlRecord(page, FIXTURE_JSONL_NESTED_LINE);
    await page.waitForTimeout(150);
    const nestedSection = page.locator(`[data-jsonl-line="${FIXTURE_JSONL_NESTED_LINE}"]`);
    await nestedSection.getByRole('button', { name: 'Expand' }).first().click();
    await page.waitForTimeout(150);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    const followingTopExpanded = await readJsonlRecordTop(page, FIXTURE_JSONL_NESTED_LINE + 1);

    const { scrollHeight } = await readJsonlScrollMetrics(page);
    await scrollJsonlPreview(page, scrollHeight);
    await page.waitForTimeout(100);
    await scrollJsonlPreview(page, 0);
    await page.waitForTimeout(150);

    await expect(nestedSection.getByRole('button', { name: 'Collapse record' })).toBeVisible();
    const followingTopAfterScroll = await readJsonlRecordTop(page, FIXTURE_JSONL_NESTED_LINE + 1);
    expect(Math.abs(followingTopAfterScroll - followingTopExpanded)).toBeLessThanOrEqual(8);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('long-string record expand exposes inspector string expand (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    await expandJsonlRecord(page, FIXTURE_JSONL_LONG_STRING_LINE);
    await page.waitForTimeout(150);

    const section = page.locator(`[data-jsonl-line="${FIXTURE_JSONL_LONG_STRING_LINE}"]`);
    const stringExpand = section.getByRole('button', { name: 'Expand' }).first();
    await stringExpand.click();
    await page.waitForTimeout(150);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('narrow viewport keeps key/colon/value grammar (web)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    await expandJsonlRecord(page, FIXTURE_JSONL_LONG_STRING_LINE);
    await page.waitForTimeout(150);
    await assertInspectorKeyColonShareRowWithValue(page, FIXTURE_JSONL_LONG_STRING_LINE);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('virtual rows do not overlap while scrolling (app)', async ({ page }) => {
    await openFixtureJsonlEventsApp(page);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    const beforeLines = await readVisibleJsonlLineNumbers(page);
    const { scrollHeight } = await readJsonlScrollMetrics(page);
    const appliedScrollTop = await scrollJsonlPreview(page, scrollHeight / 3);
    expect(appliedScrollTop).toBeGreaterThan(0);

    const afterLines = await readVisibleJsonlLineNumbers(page);
    expect(new Set(afterLines)).not.toEqual(new Set(beforeLines));

    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('expand/collapse repositions following rows (app)', async ({ page }) => {
    await openFixtureJsonlEventsApp(page);

    const nextTopBefore = await readJsonlRecordTop(page, 2);
    await expandJsonlRecord(page, 1);
    await page.waitForTimeout(150);
    const nextTopExpanded = await readJsonlRecordTop(page, 2);
    expect(nextTopExpanded).toBeGreaterThan(nextTopBefore);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });
});
