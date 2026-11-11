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

test.describe('Server-owned Images capability (#3181)', () => {
  test('Workspace exposes the complete paged registry without a Session', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=images&session=none');
    await expect(page.getByTestId('images-workspace')).toBeVisible();

    // A Session is not present, but the Server-owned Images capability is.
    await expect(page.getByTestId('session-empty-state')).toHaveCount(0);
    await expect(page.getByTestId('image-row')).toHaveCount(50);
    await expect(page.getByTestId('images-page-label')).toHaveText('1–50 of 235');
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

  test('Sandbox owns its image composition and pins Agent cache observations', async ({
    page,
  }) => {
    await page.goto('/#/fixture/workspace?capability=sandbox');
    await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
    await page.getByTestId('sandbox-tab-filesystem').click();
    await expect(page.getByTestId('sandbox-image-composition')).toBeVisible();

    await page.getByTestId('sandbox-image-add-open').click();
    await expect(page.getByTestId('sandbox-image-picker')).toContainText(
      'Sandbox-specific',
    );
    await page.getByTestId('sandbox-image-row').first().click();
    await expect(page.getByTestId('sandbox-image-target')).toHaveValue('/');
    await page.getByTestId('sandbox-image-add').click();
    await expect(page.getByTestId('sandbox-image-selection')).toHaveCount(1);
    await expect(page.getByTestId('sandbox-image-cache')).toHaveText('Agent verified');

    await page.getByTestId('sandbox-image-add-open').click();
    await page.getByTestId('sandbox-image-row').nth(1).click();
    await page.getByTestId('sandbox-image-target').fill('/opt/tool');
    await page.getByTestId('sandbox-image-add').click();
    await expect(page.getByTestId('sandbox-image-selection')).toHaveCount(2);

    await page.getByTestId('sandbox-tab-overview').click();
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
  });

  test('a failed Agent cache is never shown as mount-ready', async ({ page }) => {
    await page.goto(
      '/#/fixture/workspace?capability=sandbox&sandbox=agent-cache-failed',
    );
    await page.getByTestId('sandbox-tab-filesystem').click();
    await page.getByTestId('sandbox-image-add-open').click();
    await page.getByTestId('sandbox-image-row').first().click();
    await page.getByTestId('sandbox-image-add').click();
    await expect(page.getByTestId('sandbox-image-cache')).toHaveText('Agent cache failed');
    await expect(page.getByTestId('sandbox-image-cache')).not.toContainText(
      'Agent verified',
    );
  });
});
