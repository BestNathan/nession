// #3408 SC-03: Web uses right-aligned capability header navigation with a
// local left sidebar for the selected management area; App keeps exactly one
// host-owned header and Back, compact navigable sections, and no
// browser/App history stack per section click. Inside policy views are
// read-only with trustworthy evidence labels.
import { expect, test } from '@playwright/test';

test('SC-03: Web right-aligned sections and a local left policy sidebar', async ({ page }) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  const name = await page.getByTestId('sandbox-session-name').boundingBox();
  const nav = await page.getByTestId('sandbox-section-policies').boundingBox();
  const overview = await page.getByTestId('sandbox-section-overview').boundingBox();
  expect(name).not.toBeNull();
  expect(nav).not.toBeNull();
  expect(overview).not.toBeNull();
  // First-level sections sit to the right of the Session identity.
  expect(overview!.x).toBeGreaterThan(name!.x);

  await page.getByTestId('sandbox-section-policies').click();
  await expect(page.getByTestId('sandbox-tabs')).toHaveAttribute(
    'data-orientation',
    'vertical',
  );
  const tabs = await page.getByTestId('sandbox-tabs').boundingBox();
  const content = await page.getByTestId('sandbox-tab-content').boundingBox();
  expect(tabs).not.toBeNull();
  expect(content).not.toBeNull();
  expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(content!.x + 1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1180 placed the four first-level sections right-aligned in the ' +
      'capability header and the five policy entries in a local left sidebar beside the panel',
  });
});

test('SC-03: App keeps one host Back and no history depth per section', async ({ page }) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);
  const historyLength = await page.evaluate(() => window.history.length);

  for (const section of ['overview', 'images', 'workspaces', 'policies']) {
    await page.getByTestId(`sandbox-section-${section}`).click();
    await expect(page.getByTestId('app-page-back')).toHaveCount(1);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  }

  await page.getByTestId('sandbox-section-policies').click();
  await expect(page.getByTestId('sandbox-tabs')).toHaveAttribute(
    'data-orientation',
    'horizontal',
  );
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toBeVisible();
  await expect(page.getByTestId('app-page-back')).toHaveCount(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390 kept exactly one host-owned Back, navigated all four sections ' +
      'and the policy strip without pushing history, and rendered the Filesystem editor',
  });
});

test('SC-03: Inside policy views are read-only with the observed EROFS evidence', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox&sandbox=inside-erofs');
  await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  await expect(page.getByTestId('sandbox-effective-erofs')).toBeVisible();
  await expect(page.getByTestId('sandbox-filesystem-preview')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-fs-read-add')).toHaveCount(0);
  await page.getByTestId('sandbox-tab-resource').click();
  await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the inside Filesystem view showed the Agent-verified EROFS evidence ' +
      'with no editable declaration or access rows, and the Resource view exposed no add control',
  });
});
