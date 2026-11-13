// #3408 SC-01: with an active Session, the Sandbox capability exposes
// Overview, Images, Workspaces and Policies as distinct capability-local
// sections; the Server Images surface is rendered inside that Sandbox section
// and there is no separate Images Workspace entry. Without a Session the
// Sandbox entry is unavailable.
import { expect, test } from '@playwright/test';

test('SC-01: Session-scoped Sandbox sections; Images is not a separate Workspace entry', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await page.setViewportSize({ width: 1180, height: 900 });

  await page.goto('/#/fixture/workspace?capability=sandbox');
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
  for (const section of ['overview', 'images', 'workspaces', 'policies']) {
    await expect(page.getByTestId(`sandbox-section-${section}`)).toBeVisible();
  }

  // One Server registry, presented inside Sandbox; no independent Images tool.
  await expect(page.getByTestId('workspace-tool-images')).toHaveCount(0);
  await page.getByTestId('sandbox-section-images').click();
  await expect(page.getByTestId('sandbox-images')).toBeVisible();
  await expect(page.getByTestId('images-panel')).toBeVisible();
  for (const section of ['library', 'builds', 'distribution']) {
    await expect(page.getByTestId(`images-section-${section}`)).toBeVisible();
  }

  // Without a Session the whole capability entry is absent.
  await page.goto('/#/fixture/workspace?session=none');
  await page.reload();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-sandbox')).toHaveCount(0);
  await expect(page.getByTestId('sandbox-workspace')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a selected Session showed Overview, Images, Workspaces and Policies; ' +
      'the Images Library/Builds/Distribution surface rendered inside Sandbox with no separate ' +
      'Images Workspace entry, and a Session-less route exposed no Sandbox capability entry',
  });
});
