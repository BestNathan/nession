// #3799 SC-01 (Web half): at Web 1180/1024 the Server Catalog Library can
// search and paginate, and one row expands inline to actual Repository, Tag,
// Manifest, platform, representation/closure and reference impact. Absent
// catalog metadata and an unobserved Agent cache stay explicitly unknown
// instead of being shown as ready.
import { expect, test, type Page } from '@playwright/test';

/** One DetailFact's value cell; the fact wrapper also contains its label. */
function factValue(page: Page, testId: string) {
  return page.getByTestId(testId).locator('[data-recipe-part="detail-fact-value"]');
}

async function openWebLibrary(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=sandbox&images=lifecycle');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
}

test('SC-01: the Server Catalog Library searches, paginates and expands inline', async ({
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
    await openWebLibrary(page);
    await expect(page.getByTestId('image-row')).toHaveCount(50);
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 236');

    // Search by mutable Tag, not only by alias or digest.
    await page.getByTestId('images-search').fill('fixture-build-latest');
    await expect(page.getByTestId('image-row')).toHaveCount(1);
    await expect(page.getByTestId('images-page-label')).toHaveText('1–1 of 1');
    await page.getByTestId('image-row').first().click();
    const detail = page.getByTestId('images-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('image-detail-row')).toBeVisible();
    await expect(detail).toContainText('Server-owned immutable image');
    await expect(factValue(page, 'images-detail-repository')).toHaveText(
      'nession/fixtures',
    );
    await expect(factValue(page, 'images-detail-tags')).toHaveText(
      'fixture-build-latest',
    );
    await expect(factValue(page, 'images-detail-manifest')).toContainText('sha256:');
    await expect(factValue(page, 'images-detail-platform')).toHaveText('linux/amd64');
    await expect(factValue(page, 'images-detail-representation')).toHaveText(
      'Single layer',
    );
    await expect(factValue(page, 'images-detail-impact')).toContainText('1 Project pin');
    await expect(factValue(page, 'images-detail-impact')).toContainText('1 lease');
    await expect(factValue(page, 'images-detail-layers')).toHaveText('1');
    await expect(factValue(page, 'images-detail-closure')).toHaveText('1');
    await expect(factValue(page, 'images-detail-agent-cache')).toContainText('Unknown');
    await expect(page.getByTestId('images-tag-create')).toBeVisible();
    await expect(page.getByTestId('images-tag-remove-fixture-build-latest')).toBeVisible();

    // A revision with no readable catalog identity is explicitly unknown. The
    // newest entry is the managed one; every other inventory row is legacy.
    await page.getByTestId('images-search').fill('');
    await expect(page.getByTestId('image-row')).toHaveCount(50);
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 236');
    await page.getByTestId('image-row').nth(1).click();
    await expect(factValue(page, 'images-detail-manifest')).toHaveText(
      'Unknown manifest',
    );
    await expect(factValue(page, 'images-detail-platform')).toHaveText('Unknown platform');
    await expect(factValue(page, 'images-detail-representation')).toHaveText(
      'Unknown representation',
    );
    await expect(page.getByTestId('images-tag-unavailable')).toBeVisible();

    // The complete inventory still pages after the searched view.
    await page.getByTestId('images-next').click();
    await expect(page.getByTestId('images-page-label')).toHaveText('51–100 of 236');
    await page.getByTestId('images-previous').click();
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 236');
    observed.push(
      `${viewport.width}x${viewport.height}: Web Library search/pagination/inline detail`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the Library showed Server Repository/Tags/Manifest/Platform/Representation/closure and reference impact, and a revision without catalog metadata plus an unobserved Agent cache stayed explicitly unknown',
  });
});
