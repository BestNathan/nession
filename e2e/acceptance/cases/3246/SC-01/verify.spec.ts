// #3246 SC-01: a standard Web Select has a measurable trigger→popup geometry.
// With no collision, after the opening animation settles, the popup's start
// edge matches the trigger's start edge (≤2px) and the vertical gap is the
// configured sideOffset (≤2px), independent of which option is selected.
// `width="content"` may grow the list but does not move that anchor.
import { expect, test } from '@playwright/test';
import { freezeFixtureClock } from '../../../../helpers/fixtureVisual';
import { expectSelectAnchored } from '../../../../helpers/selectAnchor';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

test('SC-01: Web Select anchors below and start-aligned at 1440/1180/1024', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 700 },
    { width: 1024, height: 700 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture?projects=canonical');
    await page.getByTestId('project-item-row').first().waitFor();
    await page.getByTestId('project-create').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('project-location-add').click();
    const trigger = page.locator('#project-create-location-agent-0');

    // Pointer open, rich content list.
    await trigger.click();
    await expect(page.getByRole('option')).toHaveCount(3);
    const pointer = await expectSelectAnchored(page, trigger, {
      requireNoCollision: true,
    });
    expect(pointer.side).toBe('bottom');
    // `width="content"` never narrows below the anchor; growth is from the
    // same start edge, so the popup still covers the trigger's start.
    expect(pointer.popup.width).toBeGreaterThanOrEqual(pointer.trigger.width - 1);

    // Choosing the last option and re-opening must not move the anchor.
    await page.getByRole('option').last().click();
    await expect(page.getByRole('option')).toHaveCount(0);
    await trigger.click();
    const afterLast = await expectSelectAnchored(page, trigger, {
      requireNoCollision: true,
    });
    expect(Math.abs(afterLast.popup.x - pointer.popup.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterLast.gap - pointer.gap)).toBeLessThanOrEqual(1);

    // Keyboard open uses the same placement as pointer open.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option')).toHaveCount(3);
    const keyboard = await expectSelectAnchored(page, trigger, {
      requireNoCollision: true,
    });
    expect(Math.abs(keyboard.popup.x - pointer.popup.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(keyboard.gap - pointer.gap)).toBeLessThanOrEqual(1);

    // Close with Escape, choose the first option, reopen: still anchored.
    await page.keyboard.press('Escape');
    await trigger.click();
    await page.getByRole('option').first().click();
    await expect(page.getByRole('option')).toHaveCount(0);
    await trigger.click();
    const afterFirst = await expectSelectAnchored(page, trigger, {
      requireNoCollision: true,
    });
    expect(Math.abs(afterFirst.popup.x - pointer.popup.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterFirst.gap - pointer.gap)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(dialog).toBeVisible();

    observed.push(
      `${viewport.width}: trigger ${Math.round(pointer.trigger.width)}x${Math.round(pointer.trigger.height)} at ` +
        `(${pointer.trigger.x.toFixed(1)},${pointer.trigger.y.toFixed(1)}), popup ` +
        `${Math.round(pointer.popup.width)}x${Math.round(pointer.popup.height)} ` +
        `dx=${pointer.dx.toFixed(1)} gap=${pointer.gap.toFixed(1)} ` +
        `(last dx=${afterLast.dx.toFixed(1)}, keyboard dx=${keyboard.dx.toFixed(1)}, first dx=${afterFirst.dx.toFixed(1)})`,
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': standard Web Select, pointer/keyboard open, first/last option ' +
      'and close/reopen all kept a trigger-relative start edge and sideOffset; ' +
      observed.join(' | '),
  });
});

test('SC-01: a long wrapped option and a plain action list keep the same anchor', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-01');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Wrap-heavy Existing Location list (content width, long paths).
  await page.goto('/#/fixture?projects=long');
  await page.reload();
  await page.getByTestId('project-item-row').first().waitFor();
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const sessionDialog = page.getByTestId('create-session-dialog');
  await expect(sessionDialog).toBeVisible();
  const richTrigger = page.getByTestId('project-location-trigger');
  await richTrigger.click();
  await expect(page.getByRole('option')).toHaveCount(2);
  const wide = await expectSelectAnchored(page, richTrigger, {
    requireNoCollision: true,
  });
  expect(wide.side).toBe('bottom');
  expect(wide.popup.width).toBeGreaterThanOrEqual(wide.trigger.width - 1);

  // Pick the last (longest) option, then reopen; the selected index cannot
  // shift the popup on either axis.
  await page.getByRole('option').last().click();
  await expect(page.getByRole('option')).toHaveCount(0);
  await richTrigger.click();
  const afterLong = await expectSelectAnchored(page, richTrigger, {
    requireNoCollision: true,
  });
  expect(Math.abs(afterLong.popup.x - wide.popup.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterLong.gap - wide.gap)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(sessionDialog).toBeVisible();
  await sessionDialog.getByRole('button', { name: 'Cancel' }).click();

  // Ordinary single-line, anchor-width list: same invariant, width follows the
  // trigger rather than a selected item.
  await page.goto('/#/fixture/workspace?capability=env');
  await page.getByTestId('env-profile-list').waitFor();
  await page.getByTestId('env-new-menu').click();
  await page.getByTestId('env-import').click();
  await expect(page.getByTestId('env-import-dialog')).toBeVisible();
  const plainTrigger = page.getByTestId('env-import-location');
  await plainTrigger.click();
  await expect(page.getByRole('option')).toHaveCount(2);
  const plain = await expectSelectAnchored(page, plainTrigger, {
    requireNoCollision: true,
  });
  expect(plain.side).toBe('bottom');
  expect(Math.abs(plain.popup.width - plain.trigger.width)).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await plainTrigger.click();
  const plainReopened = await expectSelectAnchored(page, plainTrigger, {
    requireNoCollision: true,
  });
  expect(Math.abs(plainReopened.popup.x - plain.popup.x)).toBeLessThanOrEqual(1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': content-width long option dx=' + wide.dx.toFixed(1) +
      ' gap=' + wide.gap.toFixed(1) + ' after selecting last dx=' + afterLong.dx.toFixed(1) +
      '; plain list width=' + Math.round(plain.popup.width) +
      ' vs trigger=' + Math.round(plain.trigger.width) +
      ' dx=' + plain.dx.toFixed(1) + ' gap=' + plain.gap.toFixed(1),
  });
});
