// #3799 SC-01: at Web 1180/1024 and App 390/375 the Server Catalog Library can
// search and paginate, and one row expands inline to actual Repository, Tag,
// Manifest, platform, source, representation/closure and reference impact.
// Absent catalog metadata and an unobserved Agent cache stay explicitly
// unknown instead of being shown as ready.
import { expect, test, type Page } from '@playwright/test';


async function openWebLibrary(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=sandbox&images=lifecycle');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
}

async function openAppLibrary(page: Page): Promise<void> {
  await page.goto('/#/fixture/app?images=lifecycle');
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
}

test('SC-01: the Server Catalog Library searches, paginates and expands inline', async ({
  page,
}) => {
  test.setTimeout(240_000);
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
    await expect(page.getByTestId('images-detail-repository')).toHaveText(
      'nession/fixtures',
    );
    await expect(page.getByTestId('images-detail-tags')).toHaveText(
      'fixture-build-latest',
    );
    await expect(page.getByTestId('images-detail-manifest')).toContainText('sha256:');
    await expect(page.getByTestId('images-detail-platform')).toHaveText('linux/amd64');
    await expect(page.getByTestId('images-detail-representation')).toHaveText(
      'Single layer',
    );
    await expect(page.getByTestId('images-detail-impact')).toContainText('1 Project pin');
    await expect(page.getByTestId('images-detail-impact')).toContainText('1 lease');
    await expect(page.getByTestId('images-detail-layers')).toHaveText('1');
    await expect(page.getByTestId('images-detail-closure')).toHaveText('1');
    await expect(page.getByTestId('images-detail-agent-cache')).toContainText('Unknown');
    await expect(page.getByTestId('images-tag-create')).toBeVisible();
    await expect(page.getByTestId('images-tag-remove-fixture-build-latest')).toBeVisible();

    // A revision with no readable catalog identity is explicitly unknown.
    await page.getByTestId('images-search').fill('fixture-image-2');
    await expect(page.getByTestId('image-row')).toHaveCount(1);
    await page.getByTestId('image-row').first().click();
    await expect(page.getByTestId('images-detail-manifest')).toHaveText(
      'Unknown manifest',
    );
    await expect(page.getByTestId('images-detail-platform')).toHaveText('Unknown platform');
    await expect(page.getByTestId('images-detail-representation')).toHaveText(
      'Unknown representation',
    );
    await expect(page.getByTestId('images-tag-unavailable')).toBeVisible();

    // The complete inventory still pages after the searched view.
    await page.getByTestId('images-search').fill('');
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 236');
    await page.getByTestId('images-next').click();
    await expect(page.getByTestId('images-page-label')).toHaveText('51–100 of 236');
    await page.getByTestId('images-previous').click();
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 236');
    observed.push(`${viewport.width}x${viewport.height}: Web Library search/pagination/inline detail`);
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await openAppLibrary(page);
    await expect(page.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('app-page-back')).toBeVisible();
    await expect(page.getByTestId('image-row')).toHaveCount(50);
    const row = await page.getByTestId('image-row').first().boundingBox();
    expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.getByTestId('image-row').first().click();
    await expect(page.getByTestId('image-detail-row')).toBeVisible();
    await expect(page.getByTestId('images-detail')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    observed.push(`${viewport.width}x${viewport.height}: App inline detail, one header/back, touch floor, no overflow`);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the Library showed Server Repository/Tags/Manifest/Platform/Representation/closure and reference impact, and a revision without catalog metadata plus an unobserved Agent cache stayed explicitly unknown',
  });
});
