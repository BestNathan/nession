'use strict';
// #3181 SC-01: with no Session selected, Workspace exposes the Server-owned
// Images capability and the complete inventory can be paged and searched past
// the old 200-row bound.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-01: no-Session Workspace exposes the complete paged Images registry', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-01');
  await page.goto('/#/fixture/workspace?capability=images&session=none');
  await expect(page.getByTestId('images-workspace')).toBeVisible();
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

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a Session-free Workspace exposed the Images capability; ' +
      'the fixture registry reported 235 images and the UI paged 1–50 / 51–100 without ' +
      'truncation; search found the 235th image and its detail carried the immutable digest',
  });
});
