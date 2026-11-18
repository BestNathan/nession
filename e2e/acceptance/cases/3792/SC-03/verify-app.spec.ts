// #3792 SC-03 (App half): at App 390/375 the Filesystem editor accepts a Local
// RootFS with a Workspace and Toolchain, keeps its derived Preview and adds no
// page-level horizontal overflow behind one App header/Back.
import { expect, test, type Page } from '@playwright/test';

async function openAppFilesystem(page: Page): Promise<void> {
  await page.goto('/#/fixture/app');
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();
}

test('SC-03: the App Filesystem editor accepts Local + Workspace without overflow', async ({
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
    await openAppFilesystem(page);
    await expect(page.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('app-page-back')).toBeVisible();
    await expect(page.getByText(/requires an image RootFS/)).toHaveCount(0);
    await page.getByTestId('sandbox-workspace-auto').click();
    await expect(page.getByTestId('sandbox-filesystem-preview-workspace')).toContainText(
      'Auto by Session name',
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    observed.push(
      `${viewport.width}x${viewport.height}: App Local + Workspace preview, one header/back, no overflow`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
