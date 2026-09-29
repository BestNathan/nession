import { expect, test } from '@playwright/test';
import {
  assertVisibleJsonlRecordsDoNotOverlap,
  openFixtureJsonlEvents,
} from '../helpers/jsonlPreviewGeometry';
import { gotoFixtureWorkspace } from '../helpers/fixtureVisual';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.describe('JSONL preview geometry (#1199)', () => {
  test('virtual rows do not overlap while scrolling (web)', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEvents(page);

    await assertVisibleJsonlRecordsDoNotOverlap(page);

    const scrollHost = page.getByTestId('jsonl-preview-scroll');
    await scrollHost.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 3;
    });
    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    await scrollHost.evaluate((el) => {
      el.scrollTop = (el.scrollHeight * 2) / 3;
    });
    await page.waitForTimeout(100);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('expand/collapse does not break row stacking', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEvents(page);

    const expandFirst = page.getByRole('button', { name: 'Expand record' }).first();
    await expandFirst.click();
    await assertVisibleJsonlRecordsDoNotOverlap(page);

    await expandFirst.click();
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });

  test('narrow viewport keeps separated rows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFixtureWorkspace(page);
    await openFixtureJsonlEvents(page);
    await assertVisibleJsonlRecordsDoNotOverlap(page);
  });
});
