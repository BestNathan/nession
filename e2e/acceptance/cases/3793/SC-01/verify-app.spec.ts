// #3793 SC-01 (App half): at App 390/375 the same role-specific picker shows
// role/platform/cache and refuses a referenced Composite without page-level
// horizontal overflow behind one App header/Back.
import { expect, test, type Page } from '@playwright/test';

async function openAppFilesystem(page: Page): Promise<void> {
  await page.goto('/#/fixture/app?images=picker&sandbox=agent-cache-resumable');
  await page.reload();
  await page.getByTestId('app-layer-root').waitFor();
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();
}

test('SC-01: the App picker is role-specific without overflow', async ({ page }) => {
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

    await page.getByTestId('sandbox-rootfs-image').click();
    const dialog = page.getByTestId('sandbox-image-select-dialog');
    const baseRow = dialog.locator(
      '[data-testid="sandbox-image-row"][data-image-role="base_runtime"]',
    );
    await expect(baseRow).toBeEnabled();
    await expect(baseRow).toContainText('Server Ready');
    await expect(baseRow.getByTestId('sandbox-image-cache')).toContainText(
      'Resumable partial',
    );
    const referenced = dialog.locator(
      '[data-testid="sandbox-image-row"][data-image-representation="referenced"]',
    );
    await expect(referenced).toBeDisabled();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    observed.push(
      `${viewport.width}x${viewport.height}: App role/cache projection, referenced Composite disabled, one header/back, no overflow`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
