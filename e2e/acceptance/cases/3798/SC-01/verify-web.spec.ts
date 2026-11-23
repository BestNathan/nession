// #3798 SC-01 (Web half): durable Build history is read a page at a time,
// status/source filters and search are applied by the Server before
// pagination, attempts and source provenance are visible, and a selected
// record survives a filter change instead of being reported as absent.
import { expect, test, type Page } from '@playwright/test';

async function openWebBuildHistory(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=sandbox&images=buildhistory');
  // A hash-only goto to the same URL does not reload; force a fresh fixture
  // state so each viewport starts with the unfiltered history.
  await page.reload();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
  await page.getByTestId('images-section-builds').click();
  await expect(page.getByTestId('images-builds')).toBeVisible();
}

test('SC-01: Build history pages, filters, searches and keeps its selection', async ({
  page,
}) => {
  test.setTimeout(110_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const observed: string[] = [];

  for (const viewport of [
    { width: 1180, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await openWebBuildHistory(page);

    // The history reaches records beyond the first fixed page.
    await expect(page.getByTestId('image-build-row')).toHaveCount(50);
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–50 of 60');
    await page.getByTestId('image-builds-next').click();
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('51–60 of 60');
    await page.getByTestId('image-builds-previous').click();
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–50 of 60');

    // Status and source filters are exact and compose; the Server applies them
    // before pagination, so the total is the filtered total.
    await page.getByTestId('image-builds-status-failed').click();
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–11 of 11');
    await page.getByTestId('image-builds-source-local_directory').click();
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–10 of 10');
    await page.getByTestId('image-builds-status-failed').click();
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–10 of 10');
    await page.getByTestId('image-builds-source-local_directory').click();
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–50 of 60');

    // Search reaches alias and source provenance.
    await page.getByTestId('image-builds-search').fill('nightly');
    await expect(page.getByTestId('image-build-row')).toHaveCount(1);
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–1 of 1');
    await page.getByTestId('image-builds-search').fill('');
    await expect(page.getByTestId('image-build-row')).toHaveCount(50);

    // Attempts and source provenance are exposed on the record.
    const selected = page.locator('[data-build-id="build-fixture-attempts"]');
    await selected.getByTestId('image-build-select').click();
    const detail = selected.getByTestId('image-build-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('image-build-detail-source-kind')).toHaveText('GitHub');
    await expect(detail.getByTestId('image-build-detail-source')).toContainText('@release');
    await expect(detail.getByTestId('image-build-detail-source-sha')).toHaveText(
      'a'.repeat(40),
    );
    await expect(detail.getByTestId('image-build-detail-attempt')).toHaveText('2 · Failed');
    await expect(detail.getByTestId('image-build-attempt')).toHaveCount(2);
    await expect(detail.getByTestId('image-build-attempt-diagnostic').first()).toContainText(
      'first attempt ran out of space',
    );
    await expect(detail.getByTestId('image-build-attempt-diagnostic').last()).toContainText(
      'second attempt hit the same limit',
    );

    // A filter that excludes the selected record keeps its observed snapshot
    // and never claims the history is empty.
    await page.getByTestId('image-builds-status-succeeded').click();
    await expect(page.getByTestId('image-build-selection-retained')).toBeVisible();
    await expect(page.getByTestId('image-build-selection-retained')).toContainText(
      'not claimed empty',
    );
    await expect(
      page.getByTestId('image-build-selection-retained').getByTestId('image-build-detail'),
    ).toBeVisible();
    await expect(page.getByTestId('image-build-selection-retained')).toContainText(
      'build-fixture-attempts',
    );
    observed.push(
      `${viewport.width}x${viewport.height}: 1–50/51–60 pagination, status/source/search filters, attempt diagnostics, retained selection`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
