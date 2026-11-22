// #3799 SC-01 (App half): at App 390/375 the Server Catalog Library expands a
// row inline behind one App page header/Back, keeps a touch-sized row and adds
// no page-level horizontal overflow.
import { expect, test, type Page } from '@playwright/test';

async function openAppLibrary(page: Page): Promise<void> {
  await page.goto('/#/fixture/app?images=lifecycle');
  // A hash-only goto does not reload; force the App home so a previous
  // viewport's Workspace layer does not sit over app-header-workspace.
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
}

test('SC-01: the App Library expands a row inline without overflow', async ({
  page,
}) => {
  test.setTimeout(110_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const observed: string[] = [];

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
    observed.push(
      `${viewport.width}x${viewport.height}: App inline detail, one header/back, touch floor, no overflow`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
