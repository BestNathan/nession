// #3142 SC-04: the shared overlay stack and dismissal contract. A nested
// anchored choice stays operable above its dialog and dismisses first; modal
// surfaces restore focus, cancel/outside never confirm, and invalid/unavailable
// states stay readable without silently mutating state.
import { expect, test } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

test('SC-04: nested choices paint above the dialog and dismiss first', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('project-location-add').click();

  const trigger = dialog.locator('#project-create-location-agent-0');
  await trigger.click();
  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();
  expect(
    await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="select-content"]');
      const content = document.querySelector('[data-testid="create-project-dialog"]');
      return popup && content
        ? Number(getComputedStyle(popup).zIndex) > Number(getComputedStyle(content).zIndex)
        : false;
    }),
  ).toBe(true);
  // The choice is above the dialog: clicking it selects without dismissing the
  // parent, and the dialog remains the blocking owner.
  await options.nth(1).click();
  await expect(dialog).toBeVisible();
  await expect(trigger).not.toHaveAttribute('data-popup-open', '');

  // Escape dismisses the innermost anchored layer only, then restores focus to
  // its trigger; a second Escape dismisses the dialog.
  await trigger.click();
  await expect(options.first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Outside dismissal of a non-confirmation dialog closes it without creating
  // anything.
  await page.getByTestId('project-create').click();
  const reopened = page.getByTestId('create-project-dialog');
  await expect(reopened).toBeVisible();
  await page.mouse.click(20, 20);
  await expect(reopened).toHaveCount(0);
  expect(await page.getByTestId('project-item-row').count()).toBe(2);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the nested Select painted above the Project dialog and selected ' +
      'without dismissing it; Escape closed the Select first and restored trigger focus, then ' +
      'closed the dialog; outside dismissal created nothing',
  });
});

test('SC-04: cancel, Escape and outside never confirm a destructive alert', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  const projectId = await page
    .getByTestId('project-item-row')
    .first()
    .getAttribute('data-project-id');

  const openDelete = async () => {
    await page.getByTestId(`project-actions-${projectId}`).click();
    await page.getByTestId(`project-actions-delete-${projectId}`).click();
    const alert = page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    return alert;
  };

  let alert = await openDelete();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toHaveCount(0);
  expect(await page.getByTestId('project-item-row').count()).toBe(2);

  alert = await openDelete();
  await page.keyboard.press('Escape');
  await expect(alert).toHaveCount(0);
  expect(await page.getByTestId('project-item-row').count()).toBe(2);

  alert = await openDelete();
  await page.mouse.click(20, 20);
  await expect(alert).toBeVisible();
  await alert.getByTestId('project-delete-confirm').click();
  expect(await page.getByTestId('project-item-row').count()).toBe(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Cancel, Escape and an outside click all left the Project in place ' +
      'while the alert stayed modal on the outside click; only the explicit confirm deleted it',
  });
});

test('SC-04: invalid and unavailable states stay readable and do not mutate', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-04');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Invalid: an empty Project name is a local error, not a closed dialog.
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-create').click();
  const dialog = page.getByTestId('create-project-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('project-create-submit').click();
  await expect(dialog.getByTestId('project-dialog-error')).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.getByTestId('project-item-row').count()).toBe(2);

  // Unavailable: an offline Existing Location is explicit, the action is
  // disabled and the dialog stays readable.
  await page.goto('/#/fixture?projects=offline');
  await page.reload();
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const offline = page.getByTestId('create-session-dialog');
  await expect(offline).toBeVisible();
  await expect(offline.getByTestId('project-location-offline')).toBeVisible();
  await expect(offline.getByTestId('create-session-submit')).toBeDisabled();
  await expect(offline.getByTestId('project-location-trigger')).toContainText('Agent offline');
  await page.keyboard.press('Escape');
  await expect(offline).toHaveCount(0);
  expect(await page.getByTestId('session-item-row').count()).toBe(6);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the empty-name Project error stayed in the dialog and created ' +
      'nothing; the offline Existing Location stayed readable with Create disabled, and Escape ' +
      'closed it without creating a Session',
  });
});
