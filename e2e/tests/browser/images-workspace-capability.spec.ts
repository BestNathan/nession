import { expect, test, type Page } from '@playwright/test';

// Fixture-only browser proof for the Server-owned Images surfaces. Browser
// execution stays CI-only by the repository E2E policy.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');
test.use({ viewport: { width: 1180, height: 900 } });

async function openProjectSettings(page: Page): Promise<void> {
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await page.getByTestId('project-detail-settings').click();
  await expect(page.getByTestId('project-settings-dialog')).toBeVisible();
}

test.describe('Server-owned Images in the Sandbox capability (#3181, #3408)', () => {
  test('Sandbox exposes the complete paged registry in its Images section', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=sandbox');
    await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
    await page.getByTestId('sandbox-section-images').click();
    await expect(page.getByTestId('sandbox-images')).toBeVisible();

    // The Server registry is global; the Session-scoped Sandbox presents it.
    await expect(page.getByTestId('image-row')).toHaveCount(50);
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 235');
    // The Library is a single list: detail expands inline under its row.
    await expect(page.getByTestId('images-detail')).toHaveCount(0);
    await page.getByTestId('image-row').first().click();
    await expect(page.getByTestId('image-detail-row')).toBeVisible();
    await expect(page.getByTestId('images-detail')).toContainText('Server-owned immutable image');
    await expect(page.getByTestId('images-detail')).toContainText('Server Ready');

    await page.getByTestId('images-next').click();
    await expect(page.getByTestId('images-page-label')).toHaveText('51–100 of 235');
    await page.getByTestId('images-previous').click();
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 235');

    await page.getByTestId('images-search').fill('fixture-image-234');
    await expect(page.getByTestId('image-row')).toHaveCount(1);
    await expect(page.getByTestId('images-page-label')).toHaveText('1–1 of 1');
    await page.getByTestId('image-row').first().click();
    await expect(page.getByTestId('images-detail-title')).toHaveText('fixture-image-234');
    await expect(page.getByTestId('images-detail')).toContainText('sha256:');
  });

  test('Project uses its own selector and requires an explicit successful build bind', async ({
    page,
  }) => {
    await openProjectSettings(page);
    const initialDigest = await page.getByTestId('project-image-digest-field').innerText();
    expect(initialDigest).toContain('sha256:');

    await page.getByTestId('project-image-choose').click();
    await expect(page.getByTestId('project-image-picker')).toBeVisible();
    await expect(page.getByTestId('project-image-picker')).toContainText(
      'Project-specific',
    );
    await page.getByTestId('project-image-use').first().click();
    const selectedDigest = await page.getByTestId('project-image-digest-field').innerText();
    expect(selectedDigest).not.toBe(initialDigest);

    // A successful build does not auto-bind; the explicit Use this image does.
    await page.getByTestId('project-image-build').click();
    await expect(page.getByTestId('project-image-build-result')).toBeVisible();
    expect(await page.getByTestId('project-image-digest-field').innerText()).toBe(
      selectedDigest,
    );
    await page.getByTestId('project-image-use-build').click();
    const builtDigest = await page.getByTestId('project-image-digest-field').innerText();
    expect(builtDigest).not.toBe(selectedDigest);

    await page.getByTestId('project-settings-submit').click();
    await expect(page.getByTestId('project-settings-dialog')).toHaveCount(0);
    await expect(page.getByTestId('project-image-digest')).toHaveText(builtDigest);
  });

  test('a failed Project build preserves the existing reference', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical&images=buildfail');
    await page.getByTestId('project-item-row').first().click();
    await page.getByTestId('project-detail-settings').click();
    const before = await page.getByTestId('project-image-digest-field').innerText();
    await page.getByTestId('project-image-build').click();
    await expect(page.getByTestId('project-image-build-error')).toContainText(
      'The current reference is unchanged',
    );
    await expect(page.getByTestId('project-image-digest-field')).toHaveText(before);
  });

  test('Sandbox owns Filesystem image declarations and pins Agent cache observations', async ({
    page,
  }) => {
    await page.goto('/#/fixture/workspace?capability=sandbox');
    await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
    await page.getByTestId('sandbox-section-policies').click();
    await page.getByTestId('sandbox-tab-filesystem').click();
    await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();

    await page.getByTestId('sandbox-rootfs-image').click();
    await page.getByTestId('sandbox-image-row').first().click();
    await page.getByTestId('sandbox-image-select-submit').click();
    await expect(page.getByTestId('sandbox-rootfs-selected')).toBeVisible();
    await expect(page.getByTestId('sandbox-rootfs-cache')).toContainText('Verified');

    await page.getByTestId('sandbox-mount-add').click();
    const dialog = page.getByTestId('sandbox-image-select-dialog');
    await dialog.getByTestId('sandbox-image-row').nth(1).click();
    await dialog.getByTestId('sandbox-mount-target').fill('/opt/tool');
    await dialog.getByTestId('sandbox-image-select-submit').click();
    await expect(page.getByTestId('sandbox-mount-row')).toHaveCount(1);
    await expect(page.getByTestId('sandbox-filesystem-preview-mount-0')).toContainText(
      '/opt/tool',
    );

    await page.getByTestId('sandbox-section-overview').click();
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  });

  test('Workspace observes a durable build stage, cancels and retries it', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=images&images=lifecycle');
    await expect(page.getByTestId('images-builds')).toBeVisible();
    await expect(page.getByTestId('image-build-row')).toHaveCount(4);

    const running = page.locator('[data-build-id="build-fixture-running"]');
    await expect(running.getByTestId('image-build-status')).toHaveText('Building');
    await expect(running.getByTestId('image-build-stage')).toHaveText(
      'Packaging with mkfs.erofs',
    );
    // Measured counts only: no invented percentage during mkfs.
    await expect(running.getByTestId('image-build-progress')).toContainText('214 files');
    await expect(running.getByTestId('image-build-progress')).toContainText('2,400,000 bytes');
    await expect(running.getByTestId('image-build-progress')).not.toContainText('%');

    await running.getByTestId('image-build-cancel').click();
    await expect(running.getByTestId('image-build-status')).toHaveText('Canceled');

    const failed = page.locator('[data-build-id="build-fixture-failed"]');
    await expect(failed.getByTestId('image-build-error')).toContainText('mkfs.erofs failed');
    await failed.getByTestId('image-build-retry').click();
    await expect(failed.getByTestId('image-build-status')).toHaveText('Succeeded', {
      timeout: 5000,
    });

    // Navigating away and back reads the same durable inventory; the canceled
    // record is still canceled and no Project reference was rebound.
    await page.goto('/#/fixture?projects=canonical');
    await expect(page.getByTestId('project-detail')).toHaveCount(0);
    await page.goto('/#/fixture/workspace?capability=images&images=lifecycle');
    await expect(
      page.locator('[data-build-id="build-fixture-running"]').getByTestId('image-build-status'),
    ).toHaveText('Canceled');
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA fixture: the Images workspace showed the durable build stage with measured file/byte counts and no percentage, canceled an owned build, retried a failed build, and reloaded the same states after navigating away',
    });
  });

  test('a failed Agent cache is never shown as mount-ready', async ({ page }) => {
    await page.goto(
      '/#/fixture/workspace?capability=sandbox&sandbox=agent-cache-failed',
    );
    await page.getByTestId('sandbox-section-policies').click();
    await page.getByTestId('sandbox-tab-filesystem').click();
    await page.getByTestId('sandbox-rootfs-image').click();
    await page.getByTestId('sandbox-image-row').first().click();
    await page.getByTestId('sandbox-image-select-submit').click();
    await expect(page.getByTestId('sandbox-rootfs-cache')).toHaveText(
      'Cache failed · 256 KiB',
    );
    await expect(page.getByTestId('sandbox-rootfs-cache')).not.toContainText(
      'Verified',
    );
  });
});
