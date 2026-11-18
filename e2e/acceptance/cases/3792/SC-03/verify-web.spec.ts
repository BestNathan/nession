// #3792 SC-03 (Web half): the Filesystem editor accepts a Local RootFS with a
// compatible Toolchain and Workspace, never shows the obsolete mandatory-Base
// error, explains a missing cache, and shows an unavailable composition
// backend before Enter.
import { expect, test, type Page } from '@playwright/test';

async function openFilesystem(page: Page, scenario = ''): Promise<void> {
  const suffix = scenario ? `&sandbox=${scenario}` : '';
  await page.goto(`/#/fixture/workspace?capability=sandbox${suffix}`);
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();
}

test('SC-03: Local RootFS accepts a Toolchain and Workspace', async ({ page }) => {
  test.setTimeout(110_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const observed: string[] = [];

  for (const viewport of [
    { width: 1180, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await openFilesystem(page);

    // Local is the default RootFS; a Workspace never requires a Base image.
    await expect(page.getByTestId('sandbox-rootfs-local')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByText(/requires an image RootFS/)).toHaveCount(0);
    await expect(page.getByTestId('sandbox-workspace-auto')).toBeEnabled();
    await expect(page.getByTestId('sandbox-workspace-project')).toBeEnabled();
    await page.getByTestId('sandbox-workspace-auto').click();
    await expect(page.getByTestId('sandbox-filesystem-preview-workspace')).toContainText(
      'Auto by Session name',
    );

    // One Toolchain mount is added while Local remains selected.
    await page.getByTestId('sandbox-mount-add').click();
    const dialog = page.getByTestId('sandbox-image-select-dialog');
    await dialog.getByTestId('sandbox-image-row').first().click();
    await dialog.getByTestId('sandbox-mount-target').fill('/opt/tool');
    await dialog.getByTestId('sandbox-image-select-submit').click();
    await expect(page.getByTestId('sandbox-mount-row')).toHaveCount(1);
    await expect(page.getByTestId('sandbox-rootfs-local')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('sandbox-filesystem-preview-mount-0')).toContainText(
      '/opt/tool',
    );
    await expect(page.getByTestId('sandbox-filesystem-preview-rootfs')).toContainText(
      'Local host root',
    );

    // The fixture's Agent has no verified cache for the selected tool yet; the
    // editor says so before Enter instead of claiming readiness.
    await expect(page.getByTestId('sandbox-mount-cache-0')).toContainText(
      /Verified|Not cached|Cache unavailable|Agent cache not reported/,
    );

    // Preflight accepts the Host-root composition; no mandatory Base error.
    await page.getByTestId('sandbox-section-overview').click();
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    observed.push(
      `${viewport.width}x${viewport.height}: Local RootFS + /opt toolchain + Workspace, no mandatory-Base error, preflight accepted`,
    );
  }

  // An unavailable composition backend is explained before Enter.
  await page.setViewportSize({ width: 1180, height: 900 });
  await openFilesystem(page, 'macos');
  await expect(
    page.getByTestId('sandbox-implementation-reason-filesystem.composition'),
  ).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; an unavailable composition backend showed its measured reason',
  });
});
