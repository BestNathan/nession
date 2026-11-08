'use strict';
// #2791 SC-03: the diff stays inside the existing Git Workspace at the
// canonical Web desktop and App-like phone widths. Long code may scroll in the
// renderer; Workspace chrome does not clip, controls stay keyboard reachable,
// and no write affordance appears.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: desktop and phone widths keep the diff readable and scrollable', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git');
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-unstaged').first().click();

  const patch = page.getByTestId('git-diff-patch').locator('diffs-container');
  await expect(patch).toBeVisible();
  const split = page.getByTestId('git-diff-layout-split');
  await expect(split).toBeVisible();
  await split.focus();
  await expect(split).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'split');

  const desktopBody = await page.getByTestId('git-diff-body').evaluate((element) => {
    const style = getComputedStyle(element);
    return { overflowY: style.overflowY };
  });
  expect(['auto', 'scroll']).toContain(desktopBody.overflowY);
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(desktopOverflow).toBeLessThanOrEqual(1);
  expect(
    await page
      .getByTestId('git-workspace')
      .getByRole('button', { name: /push|pull|fetch|checkout|switch|discard|reset/i })
      .count(),
  ).toBe(0);

  // A patch longer than the pane scrolls inside its own body.
  await page.goto('/#/fixture/workspace?capability=git&git=diff-states');
  await page.reload();
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-unstaged').filter({ hasText: 'src/long.ts' }).click();
  await expect(patch.locator('[data-line]')).toHaveCount(101);
  const longBody = page.getByTestId('git-diff-body');
  await expect(longBody).toHaveCSS('overflow-y', 'auto');
  const longScroll = await longBody.evaluate((element) => {
    element.scrollTop = 200;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(longScroll.scrollHeight).toBeGreaterThan(longScroll.clientHeight);
  expect(longScroll.scrollTop).toBeGreaterThan(0);

  // App-like phone width: one presentation, still the full patch, no page clip.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('git-diff-layout')).toHaveCount(0);
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'single');
  await expect(patch.locator('[data-line]').first()).toBeVisible();

  const code = patch.locator('[data-code]').first();
  const codeScroll = await code.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(['auto', 'scroll']).toContain(codeScroll.overflowX);
  expect(codeScroll.scrollWidth).toBeGreaterThan(codeScroll.clientWidth);

  const phone = await page.evaluate(() => {
    const line = document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]');
    const workspace = document.querySelector('[data-testid="git-workspace"]');
    const rect = workspace?.getBoundingClientRect();
    return {
      fontSize: line ? Number.parseFloat(getComputedStyle(line).fontSize) : 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      left: rect?.left ?? -1,
      right: rect?.right ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(phone.fontSize).toBeGreaterThanOrEqual(11);
  expect(phone.overflow).toBeLessThanOrEqual(1);
  expect(phone.left).toBeGreaterThanOrEqual(0);
  expect(phone.right).toBeLessThanOrEqual(391);
  expect(
    await page
      .getByTestId('git-workspace')
      .getByRole('button', { name: /push|pull|fetch|checkout|switch|discard|reset/i })
      .count(),
  ).toBe(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': 1440x900 split view keyboard-selected with no page-level ' +
      'horizontal overflow; a 101-line patch scrolled inside git-diff-body; 390x844 ' +
      'kept the single presentation, code scrolled inside the renderer, diff text ' +
      'rendered at ' + phone.fontSize + 'px, and the Workspace stayed within 0..390px; ' +
      'no remote or history-rewriting control existed',
  });
});
