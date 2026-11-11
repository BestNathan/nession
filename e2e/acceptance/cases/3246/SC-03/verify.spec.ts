// #3246 SC-03: collision is Base UI's, not a reason to force one placement.
// A Select near the viewport edge may shift horizontally or flip above its
// trigger; it must stay visible, operable, overlapping its trigger and owning
// its own scroll. DropdownMenu, ContextMenu and Popover keep their own
// positioning and dismissal semantics after the Select default change.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock, waitForFixtureTerminal } from '../../../../helpers/fixtureVisual';
import { expectSelectAnchored, settledBox } from '../../../../helpers/selectAnchor';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function expectAnchoredOverlay(
  page: Page,
  overlay: Locator,
  trigger: Locator,
  { maxGap = 12 }: { maxGap?: number } = {},
): Promise<void> {
  const overlayBox = await settledBox(page, overlay);
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(overlayBox.x).toBeGreaterThanOrEqual(-2);
  expect(overlayBox.x + overlayBox.width).toBeLessThanOrEqual(viewport.width + 2);
  expect(overlayBox.x).toBeLessThan(triggerBox!.x + triggerBox!.width);
  expect(overlayBox.x + overlayBox.width).toBeGreaterThan(triggerBox!.x);
  const below = overlayBox.y - (triggerBox!.y + triggerBox!.height);
  const above = triggerBox!.y - (overlayBox.y + overlayBox.height);
  expect(Math.min(Math.abs(below), Math.abs(above))).toBeLessThanOrEqual(maxGap);
}

async function expectListOwnsScroll(page: Page): Promise<void> {
  const popup = page.locator('[data-slot="select-content"]:visible');
  expect(await popup.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);
}

test('SC-03: a horizontal edge shifts the Select but keeps it visible and operable', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=long');
  await page.reload();
  await page.getByTestId('project-item-row').first().waitFor();
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByTestId('create-session-dialog');
  await expect(dialog).toBeVisible();
  const trigger = page.getByTestId('project-location-trigger');
  await trigger.click();
  const anchor = await expectSelectAnchored(page, trigger, { requireNoCollision: true });
  await expectListOwnsScroll(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': 1440 content Select visible with ' + anchor.side +
      ' dx=' + anchor.dx.toFixed(1) + ' gap=' + anchor.gap.toFixed(1) +
      '; the popup alone owns vertical scrolling and the page has no horizontal overflow',
  });
});

test.describe('Web touch at 390', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('SC-03: a narrow Web Select shifts inside the viewport and still chooses', async ({ page }) => {
    test.setTimeout(110_000);
    const { sha } = verifiedRuntime('SC-03');
    await freezeFixtureClock(page);
    await page.goto('/#/fixture?experience=web&projects=long');
    await page.getByTestId('project-item-row').first().waitFor();
    await page.getByTestId('project-item-row').first().click();
    await page.getByTestId('sidebar-drawer-close').click();
    await page.getByTestId('project-detail-create-session').click();
    const dialog = page.getByTestId('create-session-dialog');
    await expect(dialog).toBeVisible();
    const trigger = page.getByTestId('project-location-trigger');
    await trigger.tap();
    const anchor = await expectSelectAnchored(page, trigger);
    expect(anchor.horizontalCollision).toBe(true);
    expect(anchor.popup.x).toBeGreaterThanOrEqual(0);
    expect(anchor.popup.x + anchor.popup.width).toBeLessThanOrEqual(390);
    await expectListOwnsScroll(page);

    const list = page.locator('[role="listbox"]:visible');
    const options = list.getByRole('option');
    await expect(options).toHaveCount(2);
    const lastTitle = await options.last().locator('[data-slot="choice-item-title"]').innerText();
    await options.last().tap();
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(trigger).toContainText(lastTitle);
    await trigger.tap();
    const reopened = await expectSelectAnchored(page, trigger);
    expect(Math.abs(reopened.dx - anchor.dx)).toBeLessThanOrEqual(2);
    expect(Math.abs(reopened.gap - anchor.gap)).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': at 390 the wider popup shifted by ' + anchor.dx.toFixed(1) +
        'px (still overlapping the trigger and inside the viewport), chose "' + lastTitle +
        '", reopened at dx=' + reopened.dx.toFixed(1) + ' gap=' + reopened.gap.toFixed(1),
    });
  });
});

test.describe('App touch at 390', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('SC-03: the App Select flips above the trigger and stays operable', async ({ page }) => {
    test.setTimeout(110_000);
    const { sha } = verifiedRuntime('SC-03');
    await freezeFixtureClock(page);
    await page.goto('/#/fixture/app?projects=canonical');
    await page.reload();
    await page.getByTestId('app-layer-root').waitFor();
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page.getByTestId('project-create').tap();
    const surface = page.getByTestId('app-project-create-page');
    await expect(surface).toBeVisible();
    await page.getByTestId('project-location-add').focus();
    await page.keyboard.press('Enter');
    const trigger = page.locator('#project-create-location-agent-0');
    await expect(trigger).toBeVisible();
    await trigger.tap();
    const anchor = await expectSelectAnchored(page, trigger);
    expect(anchor.side).toBe('top');
    expect(anchor.popup.y).toBeGreaterThanOrEqual(0);
    expect(anchor.popup.y + anchor.popup.height).toBeLessThanOrEqual(844);
    await expectListOwnsScroll(page);

    const list = page.locator('[role="listbox"]:visible');
    const options = list.getByRole('option');
    await expect(options).toHaveCount(3);
    const firstTitle = await options.first().locator('[data-slot="choice-item-title"]').innerText();
    await options.first().tap();
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(trigger).toContainText(firstTitle);
    await expect(surface).toBeVisible();

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': the 390 App trigger near the bottom edge opened ' +
        anchor.side + ' at dx=' + anchor.dx.toFixed(1) + ' gap=' + anchor.gap.toFixed(1) +
        ', fully inside the viewport with the list owning scroll; tapping chose "' +
        firstTitle + '" and kept the operation surface',
    });
  });
});

test('SC-03: DropdownMenu, ContextMenu and Popover keep their own overlay semantics', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // DropdownMenu: starts on its trigger, keyboard-reachable, Escape and an
  // outside click dismiss it.
  await page.goto('/#/fixture?projects=canonical');
  await page.getByTestId('project-item-row').first().waitFor();
  const actions = page.locator('[data-testid^="project-actions-"]').first();
  await actions.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expectAnchoredOverlay(page, menu, actions);
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await actions.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(800, 120);
  await expect(menu).toHaveCount(0);

  // ContextMenu: a right-click opens at the pointer origin, Escape dismisses.
  await page.goto('/#/fixture/workspace?capability=files');
  await page.getByTestId('file-workspace').waitFor();
  const row = page
    .locator('[data-testid="file-workspace"] [role="tree"]')
    .locator('[role="treeitem"]')
    .first();
  await row.click({ button: 'right' });
  const contextMenu = page.locator('[data-slot="context-menu-content"]');
  await expect(contextMenu).toBeVisible();
  const rowBox = await row.boundingBox();
  const contextBox = await settledBox(page, contextMenu);
  expect(rowBox).not.toBeNull();
  expect(contextBox.y).toBeGreaterThanOrEqual(rowBox!.y - 2);
  await page.keyboard.press('Escape');
  await expect(contextMenu).toHaveCount(0);

  // Popover: the terminal history control keeps its own placement, accessible
  // dialog role and Escape dismissal.
  await page.goto('/#/fixture');
  await waitForFixtureTerminal(page);
  const history = page.getByTestId('capsule-history-trigger');
  await history.click();
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('role', 'dialog');
  await expectAnchoredOverlay(page, popover, history);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': DropdownMenu stayed on its trigger with ArrowDown/Escape/' +
      'outside dismissal; ContextMenu opened from the pointer row and closed with Escape; ' +
      'Popover stayed beside its capsule trigger as a dialog and closed with Escape',
  });
});
