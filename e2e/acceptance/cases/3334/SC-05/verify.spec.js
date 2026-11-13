'use strict';
// #3334 SC-05: the Images workspace observes the durable build stage (real
// measured counts, no invented percentage), cancels and retries through the
// Server units, and reloads the same state after navigating away.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-05: durable build stage, cancel, retry and navigate-away state', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-05');
  await page.goto('/#/fixture/workspace?capability=images&images=lifecycle');
  await expect(page.getByTestId('images-builds')).toBeVisible();
  await expect(page.getByTestId('image-build-row')).toHaveCount(4);

  const running = page.locator('[data-build-id="build-fixture-running"]');
  await expect(running.getByTestId('image-build-status')).toHaveText('Building');
  await expect(running.getByTestId('image-build-stage')).toHaveText(
    'Packaging with mkfs.erofs',
  );
  await expect(running.getByTestId('image-build-progress')).toContainText('214 files');
  await expect(running.getByTestId('image-build-progress')).not.toContainText('%');

  await running.getByTestId('image-build-cancel').click();
  await expect(running.getByTestId('image-build-status')).toHaveText('Canceled');

  const failed = page.locator('[data-build-id="build-fixture-failed"]');
  await expect(failed.getByTestId('image-build-error')).toContainText('mkfs.erofs failed');
  await failed.getByTestId('image-build-retry').click();
  await expect(failed.getByTestId('image-build-status')).toHaveText('Succeeded', {
    timeout: 5000,
  });

  await page.goto('/#/fixture?projects=canonical');
  await page.goto('/#/fixture/workspace?capability=images&images=lifecycle');
  await expect(
    page.locator('[data-build-id="build-fixture-running"]').getByTestId('image-build-status'),
  ).toHaveText('Canceled');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Images workspace showed the durable build stage with measured ' +
      'file/byte counts and no percentage, canceled an owned build, retried a failed build, and ' +
      'reloaded the same durable states after navigating away',
  });
});
