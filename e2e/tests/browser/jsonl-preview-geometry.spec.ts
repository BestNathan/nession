import { expect, test } from '@playwright/test';
import {
  assertInspectorKeyColonShareRowWithValue,
  assertVisibleJsonlRecordsDoNotOverlap,
  collapseJsonlRecord,
  expandJsonlRecord,
  FIXTURE_JSONL_LONG_STRING_LINE,
  FIXTURE_JSONL_NESTED_LINE,
  openFixtureJsonlEventsApp,
  openFixtureJsonlEventsWeb,
  resyncJsonlMeasurementsThrough,
  readJsonlRecordTop,
  readJsonlScrollMetrics,
  scrollJsonlPreview,
  scrollJsonlRecordIntoView,
  scrollJsonlUntilWindowChanges,
} from '../../helpers/jsonlPreviewGeometry';
import { gotoFixtureWorkspace } from '../../helpers/fixtureVisual';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.describe('JSONL preview geometry (#1199)', () => {
  test('virtual rows do not overlap while scrolling (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    await assertVisibleJsonlRecordsDoNotOverlap(page);
    await scrollJsonlUntilWindowChanges(page);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    const { scrollHeight } = await readJsonlScrollMetrics(page);
    await scrollJsonlPreview(page, (scrollHeight * 2) / 3);
    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('expand/collapse repositions following rows (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);
    await scrollJsonlPreview(page, 0);

    const nextLine = 2;
    await scrollJsonlRecordIntoView(page, 1);
    const nextTopBefore = await readJsonlRecordTop(page, nextLine);

    await expandJsonlRecord(page, 1);
    await page.waitForTimeout(150);
    const nextTopExpanded = await readJsonlRecordTop(page, nextLine);
    expect(nextTopExpanded).toBeGreaterThan(nextTopBefore);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    await collapseJsonlRecord(page, 1);
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
    const nestedSection = page.locator(`[data-jsonl-line="${FIXTURE_JSONL_NESTED_LINE}"]`).first();
    await nestedSection.getByRole('button', { name: 'Expand' }).first().click();
    await page.waitForTimeout(150);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    const followingLine = FIXTURE_JSONL_NESTED_LINE + 1;
    const followingSection = page.locator(`[data-jsonl-line="${followingLine}"]`).first();

    const { scrollHeight } = await readJsonlScrollMetrics(page);
    await scrollJsonlPreview(page, scrollHeight);
    await page.waitForTimeout(100);
    await scrollJsonlPreview(page, 0);
    await page.waitForTimeout(150);

    await resyncJsonlMeasurementsThrough(page, followingLine);
    await scrollJsonlRecordIntoView(page, FIXTURE_JSONL_NESTED_LINE);
    await expect(nestedSection.getByRole('button', { name: 'Collapse record' })).toBeVisible();

    const innerExpand = nestedSection.getByRole('button', { name: 'Expand' }).first();
    if (await innerExpand.isVisible()) {
      await innerExpand.click();
      await page.waitForTimeout(150);
    }

    await expect(followingSection).toBeVisible();
    const nestedBox = await nestedSection.boundingBox();
    const followingBox = await followingSection.boundingBox();
    expect(nestedBox).not.toBeNull();
    expect(followingBox).not.toBeNull();
    expect(followingBox!.y).toBeGreaterThanOrEqual(nestedBox!.y - 2);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('long-string record expand exposes inspector string expand (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEventsWeb(page);

    await expandJsonlRecord(page, FIXTURE_JSONL_LONG_STRING_LINE);
    await page.waitForTimeout(150);

    const section = page.locator(`[data-jsonl-line="${FIXTURE_JSONL_LONG_STRING_LINE}"]`).first();
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
    await scrollJsonlUntilWindowChanges(page);
    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('expand/collapse repositions following rows (app)', async ({ page }) => {
    await openFixtureJsonlEventsApp(page);
    await scrollJsonlPreview(page, 0);

    await scrollJsonlRecordIntoView(page, 1);
    const nextTopBefore = await readJsonlRecordTop(page, 2);
    await expandJsonlRecord(page, 1);
    await page.waitForTimeout(150);
    const nextTopExpanded = await readJsonlRecordTop(page, 2);
    expect(nextTopExpanded).toBeGreaterThan(nextTopBefore);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });
});
