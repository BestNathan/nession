'use strict';
// #3181 SC-04: Server Ready and Agent verified/failed cache are separate
// observations; a failed Agent cache is not presented as mount-ready.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-04: a failed Agent cache is distinct from Server readiness', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-04');
  await page.goto(
    '/#/fixture/workspace?capability=sandbox&sandbox=agent-cache-failed',
  );
  await page.getByTestId('sandbox-tab-filesystem').click();
  await page.getByTestId('sandbox-image-add-open').click();
  await page.getByTestId('sandbox-image-row').first().click();
  await page.getByTestId('sandbox-image-add').click();
  await expect(page.getByTestId('sandbox-image-selection')).toHaveCount(1);
  await expect(page.getByTestId('sandbox-image-selection')).toContainText('Server Ready');
  await expect(page.getByTestId('sandbox-image-cache')).toHaveText('Agent cache failed');
  await expect(page.getByTestId('sandbox-image-cache')).not.toContainText('Agent verified');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the selected image remained Server Ready while its Agent cache ' +
      'was reported as failed, never as mount-ready; the UI kept the two observations separate',
  });
});
