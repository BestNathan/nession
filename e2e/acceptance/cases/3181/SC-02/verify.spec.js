'use strict';
// #3181 SC-02: Project and Sandbox use independent image flows. Project requires
// an explicit successful build bind; Sandbox owns target/mode composition.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-02: Project and Sandbox select images through independent flows', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-02');

  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-settings').click();
  await expect(page.getByTestId('project-settings-dialog')).toBeVisible();
  const initial = await page.getByTestId('project-image-digest-field').innerText();
  await page.getByTestId('project-image-choose').click();
  await expect(page.getByTestId('project-image-picker')).toContainText('Project-specific');
  await page.getByTestId('project-image-use').first().click();
  const selected = await page.getByTestId('project-image-digest-field').innerText();
  expect(selected).not.toBe(initial);
  await page.getByTestId('project-image-build').click();
  await expect(page.getByTestId('project-image-build-result')).toBeVisible();
  expect(await page.getByTestId('project-image-digest-field').innerText()).toBe(selected);
  await page.getByTestId('project-image-use-build').click();
  const built = await page.getByTestId('project-image-digest-field').innerText();
  expect(built).not.toBe(selected);
  await page.getByTestId('project-settings-submit').click();
  await expect(page.getByTestId('project-image-digest')).toHaveText(built);

  await page.goto('/#/fixture/workspace?capability=sandbox');
  await page.getByTestId('sandbox-tab-filesystem').click();
  await page.getByTestId('sandbox-image-add-open').click();
  await expect(page.getByTestId('sandbox-image-picker')).toContainText('Sandbox-specific');
  await page.getByTestId('sandbox-image-row').first().click();
  await page.getByTestId('sandbox-image-add').click();
  await expect(page.getByTestId('sandbox-image-selection')).toHaveCount(1);
  await page.getByTestId('sandbox-image-add-open').click();
  await page.getByTestId('sandbox-image-row').nth(1).click();
  await page.getByTestId('sandbox-image-target').fill('/opt/tool');
  await page.getByTestId('sandbox-image-add').click();
  await expect(page.getByTestId('sandbox-image-selection')).toHaveCount(2);
  await expect(page.getByTestId('sandbox-image-composition')).toContainText(
    'independent of the Project image reference',
  );

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Project used its own single-image selector and changed its ' +
      'reference only after the successful build and explicit Use this image; Sandbox used ' +
      'its own add-image flow to compose a Base and /opt/tool target without a Project selector',
  });
});
