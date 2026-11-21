// #3798 SC-01 (App half): at App 390/375 the durable Build history pages,
// opens a record's attempt/source detail inline and adds no page-level
// horizontal overflow behind one App header/Back.
import { expect, test, type Page } from '@playwright/test';

async function openAppBuildHistory(page: Page): Promise<void> {
  await page.goto('/#/fixture/app?images=buildhistory');
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('images-panel')).toBeVisible();
  await page.getByTestId('images-section-builds').click();
  await expect(page.getByTestId('images-builds')).toBeVisible();
}

test('SC-01: the App Build history pages and expands attempts without overflow', async ({
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
    await openAppBuildHistory(page);
    await expect(page.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('app-page-back')).toBeVisible();
    await expect(page.getByTestId('image-build-row')).toHaveCount(50);
    await expect(page.getByTestId('image-builds-page-label')).toHaveText('1–50 of 60');

    const selected = page.locator('[data-build-id="build-fixture-attempts"]');
    await selected.getByTestId('image-build-select').click();
    await expect(selected.getByTestId('image-build-detail')).toBeVisible();
    await expect(selected.getByTestId('image-build-detail-attempt')).toContainText('2 · Failed');
    await expect(selected.getByTestId('image-build-attempt')).toHaveCount(2);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    observed.push(
      `${viewport.width}x${viewport.height}: App history paging, attempt detail, one header/back, no overflow`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
