'use strict';
// #4115 SC-03: in Files bulk selection the Copy/Delete actions are fully
// visible, focusable and tappable above the Capsule at its compact/expanded
// heights, while the last FileList row still scrolls into view. The actions are
// mounted by the Host's one Bottom Actions role (not a capability-owned footer),
// and clearing the selection reserves nothing.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-03 Files bulk actions live in the Host slot and clear the Capsule', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await helper.openFilesLong(page);
    await helper.longPress(page, '[data-testid="file-row-bulk/filler-00000.txt"]');
    await page.getByTestId('files-app-selection-top').waitFor({ timeout: 10_000 });
    await expect(page.getByTestId('files-app-selection-top')).toContainText('1 selected');
    const actions = page.getByTestId('files-app-selection-bottom');
    await actions.waitFor({ timeout: 10_000 });

    const host = await helper.bottomActionsState(page);
    expect(host, 'the Host Bottom Actions slot exists').not.toBeNull();
    expect(host.ownedByHost, 'the action row is portalled into the Host slot').toBe(true);
    expect(host.insideCapabilityRoot, 'the action row is not a capability-owned footer').toBe(false);
    expect(host.slot.children).toBeGreaterThan(0);
    expect(host.actions.bottom, 'Copy/Delete end above the Capsule')
      .toBeLessThanOrEqual(host.capsuleTop + helper.ROUNDING_TOLERANCE_PX);
    expect(host.actions.top, 'the action row starts at or below the slot top')
      .toBeGreaterThanOrEqual(host.slot.top - helper.ROUNDING_TOLERANCE_PX);
    expect(host.list.bottom, 'the FileList ends above the Host actions row')
      .toBeLessThanOrEqual(host.slot.top + helper.ROUNDING_TOLERANCE_PX);
    expect(Number.parseFloat(host.slot.paddingBottom), 'the Host applies the Capsule band')
      .toBeGreaterThan(0);

    const copy = page.getByRole('button', { name: 'Copy' });
    const remove = page.getByRole('button', { name: 'Delete' });
    for (const [label, button] of [['Copy', copy], ['Delete', remove]]) {
      await expect(button, label + ' renders').toBeVisible();
      await expect(button, label + ' is enabled with a nonempty selection').toBeEnabled();
      const box = await button.boundingBox();
      expect(box, label + ' is laid out').not.toBeNull();
      expect(box.height, label + ' meets the App control band').toBeGreaterThanOrEqual(44);
      await button.focus();
      await expect(button, label + ' is focusable').toBeFocused();
    }

    // The destructive action is tappable: its confirmation opens and Cancel
    // preserves the selection and the Host band.
    await remove.click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(actions).toBeVisible();

    // The last FileList row can still be scrolled into view, above the Host
    // actions and the Capsule.
    const selectionEnd = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(selectionEnd, `Files selection ${viewport.id}`);
    helper.expectHostInset(selectionEnd, `Files selection ${viewport.id}`);
    expect(selectionEnd.host.mode).toBe('bounded');
    expect(Number.parseFloat(selectionEnd.host.scrollInset), 'the actions row removes the tail')
      .toBe(0);
    expect(selectionEnd.lastActionable.bottom, 'the last row clears the actions row and Capsule')
      .toBeLessThanOrEqual(selectionEnd.capsuleTop + helper.ROUNDING_TOLERANCE_PX);

    // Clearing selection removes the contribution; the slot reserves no space.
    await page.getByTestId('files-app-selection-top').getByRole('button', { name: 'Exit selection' }).click();
    await expect(actions).toBeHidden();
    const cleared = await helper.bottomActionsState(page);
    expect(cleared.slot.display, 'an empty Host slot is hidden, not a fake footer').toBe('none');
    const restored = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(restored, `Files cleared ${viewport.id}`);
    helper.expectHostInset(restored, `Files cleared ${viewport.id}`);
    expect(Number.parseFloat(restored.host.scrollInset), 'clearing restores the scroll band')
      .toBeGreaterThan(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 a long-press selection mounted '
      + 'Files Copy/Delete inside the single Host workspace-bottom-actions slot '
      + '(not inside files-app-layout); both buttons were visible, enabled, '
      + 'focusable and >=44px, Delete opened its confirmation, the FileList '
      + 'ended above the slot, the last row still scrolled above the Capsule and '
      + 'the Host actions, scrollInset was 0 while actionsInset equalled the '
      + 'band, and exiting selection hid the empty slot and restored the band.',
  });
});
