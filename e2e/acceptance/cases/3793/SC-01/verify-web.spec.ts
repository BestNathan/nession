// #3793 SC-01 (Web half): each Sandbox picker is role-specific, shows the
// Server role, platform, representation and this Session Agent's cache phase
// separately from Server Ready, and never offers a referenced Composite or a
// platform-mismatched image as executable.
import { expect, test, type Page } from '@playwright/test';

async function openFilesystem(page: Page): Promise<void> {
  await page.goto(
    '/#/fixture/workspace?capability=sandbox&images=picker&sandbox=agent-cache-resumable',
  );
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();
}

test('SC-01: role, platform, representation and Agent cache govern the picker', async ({
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
    await openFilesystem(page);

    // ── RootFS is Base Runtime only ──
    await page.getByTestId('sandbox-rootfs-image').click();
    const baseDialog = page.getByTestId('sandbox-image-select-dialog');
    const baseRow = baseDialog.locator(
      '[data-testid="sandbox-image-row"][data-image-role="base_runtime"]',
    );
    await expect(baseRow).toHaveCount(1);
    await expect(baseRow).toBeEnabled();
    await expect(baseRow).toContainText('Base Runtime');
    await expect(baseRow).toContainText('Server Ready');
    await expect(baseRow.getByTestId('sandbox-image-platform')).toHaveText('linux/amd64');
    // The Agent cache phase is a separate observation, including a resumable
    // partial that is not verified or mount-ready.
    await expect(baseRow.getByTestId('sandbox-image-cache')).toHaveText(
      'Resumable partial · 512 KiB',
    );
    const toolInRootfs = baseDialog.locator(
      '[data-testid="sandbox-image-row"][data-image-role="tool"]',
    );
    await expect(toolInRootfs.first()).toBeDisabled();
    await expect(toolInRootfs.first()).toContainText('Not a Base Runtime image');
    await baseRow.click();
    await baseDialog.getByTestId('sandbox-image-select-submit').click();
    await expect(page.getByTestId('sandbox-rootfs-selected')).toBeVisible();

    // ── Toolchain mounts exclude Base, mismatch and referenced Composite ──
    await page.getByTestId('sandbox-mount-add').click();
    const mountDialog = page.getByTestId('sandbox-image-select-dialog');
    const baseInMounts = mountDialog
      .locator('[data-testid="sandbox-image-row"][data-image-role="base_runtime"]')
      .first();
    await expect(baseInMounts).toBeDisabled();
    await expect(baseInMounts).toContainText('Not a Toolchain image');
    const mismatched = mountDialog.locator(
      '[data-testid="sandbox-image-row"][data-image-platform="linux/arm64"]',
    );
    await expect(mismatched).toBeDisabled();
    await expect(mismatched).toContainText('does not match this Agent (linux/amd64)');
    const referenced = mountDialog.locator(
      '[data-testid="sandbox-image-row"][data-image-representation="referenced"]',
    );
    await expect(referenced).toBeDisabled();
    await expect(referenced).toContainText('Referenced composite images are not executable');
    const toolRow = mountDialog.locator(
      '[data-testid="sandbox-image-row"][data-image-role="tool"]:enabled',
    );
    await expect(toolRow).toHaveCount(1);
    await toolRow.click();
    // The advisory mount default proposes the target; it never authorizes it.
    await expect(mountDialog.getByTestId('sandbox-mount-target')).toHaveValue('/opt/node');
    await mountDialog.getByTestId('sandbox-image-select-submit').click();
    await expect(page.getByTestId('sandbox-mount-row')).toHaveCount(1);
    await expect(page.getByTestId('sandbox-mount-target-0')).toHaveValue('/opt/node');
    await expect(page.getByTestId('sandbox-filesystem-preview-mount-0')).toContainText(
      '/opt/node',
    );
    observed.push(
      `${viewport.width}x${viewport.height}: role-specific Base/Toolchain pickers, platform and Agent cache phase, referenced Composite refused, mount default /opt/node`,
    );
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; '),
  });
});
