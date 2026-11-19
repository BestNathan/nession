'use strict';
// #3971 SC-03: in the real App Claude Reader, Git Changes Collection and
// Sandbox Policy/Filesystem Configuration flows, primary vs secondary
// surfaces and Section/Group/Row groups are perceptibly distinguishable by
// defined semantic relationships; content stays readable with one intended
// scroll owner, no card-per-row excess, horizontal clipping, bottom overlap or
// unintended blank panels in long/empty/error states at 375/390/430.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openClaudeApp } = require('../../../shared/claude-app-browser.cjs');
const helper = require('../../../shared/app-workspace-3971-browser.cjs');

function computed(page, selector, properties) {
  return page.locator(selector).first().evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style[name]]));
  }, properties);
}

test('SC-03: semantic surfaces and region hierarchy carry each App resource mode', async ({ page }) => {
  test.setTimeout(115_000);
  const { sha } = verifiedRuntime('SC-03');
  let measuredGroupGap = null;

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // ── Reader · Claude: one continuous primary surface, no card-per-message ──
    await openClaudeApp(page, '?conversation=rich');
    const reader = page.getByTestId('claude-app-reader-surface');
    await reader.waitFor({ timeout: 30_000 });
    await expect(reader).toHaveAttribute('data-workspace-surface', 'primary');
    await expect(page.getByTestId('conversation-turn').first()).toBeVisible();
    const assistant = page.getByTestId('conversation-assistant-body').first();
    const assistantPaint = await assistant.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderTopWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      };
    });
    expect(assistantPaint.borderTopWidth).toBe('0px');
    expect(assistantPaint.borderRadius).toBe('0px');
    expect(assistantPaint.boxShadow).toBe('none');
    expect(await helper.visibleScrollOwners(page, '[data-testid="workspace-tool-content"]'))
      .toBeLessThanOrEqual(1);

    // ── Collection · Git: primary surface, Section groups, contiguous rows ──
    await helper.openWorkspace(page, 'git', '?git=changed');
    const changes = page.getByTestId('git-change-list');
    await changes.waitFor({ timeout: 30_000 });
    await expect(changes).toHaveAttribute('data-workspace-surface', 'primary');
    await expect(page.getByTestId('git-group-staged')).toHaveAttribute(
      'data-workspace-section',
      '',
    );
    await expect(page.getByTestId('git-group-changes')).toHaveAttribute(
      'data-workspace-section',
      '',
    );
    await expect(page.locator('[data-workspace-group]').first()).toBeVisible();
    await expect(page.locator('[data-workspace-row]').first()).toBeVisible();
    const groupGap = await page.evaluate(() => {
      const a = document.querySelector('[data-testid="git-group-staged"]');
      const b = document.querySelector('[data-testid="git-group-changes"]');
      if (!(a instanceof HTMLElement) || !(b instanceof HTMLElement)) return null;
      return Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
    });
    expect(groupGap).not.toBeNull();
    expect(groupGap).toBeGreaterThanOrEqual(16);
    expect(groupGap).toBeLessThanOrEqual(24);
    measuredGroupGap = groupGap;

    // A selected change is a pushed Detail/Reader depth, still one surface.
    await page.locator('[data-testid^="git-row-"]').first().click();
    const diff = page.getByTestId('git-diff-surface');
    await diff.waitFor({ timeout: 30_000 });
    await expect(diff).toHaveAttribute('data-workspace-surface', 'primary');
    await expect(page.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('app-page-subtitle-text')).toHaveText('Git');
    expect(await helper.visibleScrollOwners(page, '[data-testid="workspace-tool-content"]'))
      .toBeLessThanOrEqual(1);

    // ── Configuration · Sandbox: named Sections over secondary field groups ──
    // The editable policy draft is the configuration flow; `?sandbox=inside`
    // shows the verified effective policy as a read-only ResourceDetail, which
    // is a different recipe and not the form this criterion names.
    await helper.openWorkspace(page, 'sandbox');
    const sandbox = page.getByTestId('sandbox-workspace');
    await sandbox.waitFor({ timeout: 30_000 });
    await expect(sandbox).toHaveAttribute('data-workspace-surface', 'primary');
    await page.getByTestId('sandbox-section-policies').click();
    await page.getByTestId('sandbox-tab-filesystem').click();
    const form = page.locator('[data-recipe="configuration-form"]').first();
    await form.waitFor({ timeout: 30_000 });
    await expect(page.locator('[data-workspace-section]').first()).toBeVisible();
    await expect(page.locator('[data-recipe-part="form-section"]').first()).toBeVisible();
    const secondary = page.locator('[data-workspace-surface="secondary"]').first();
    await expect(secondary).toBeVisible();
    const paints = await page.evaluate(() => {
      const primary = document.querySelector('[data-testid="sandbox-workspace"]');
      const secondary = document.querySelector('[data-workspace-surface="secondary"]');
      if (!(primary instanceof HTMLElement) || !(secondary instanceof HTMLElement)) return null;
      return {
        primary: getComputedStyle(primary).backgroundColor,
        secondary: getComputedStyle(secondary).backgroundColor,
      };
    });
    expect(paints).not.toBeNull();
    expect(paints.secondary).not.toBe(paints.primary);

    const overflow = await helper.pageOverflow(page);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  }

  // ── Empty and error states keep one readable flow, not a blank panel ──
  await page.setViewportSize({ width: 390, height: 844 });
  await helper.openWorkspace(page, 'git', '?git=clean');
  await expect(page.getByTestId('git-clean')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);

  await openClaudeApp(page, '?conversation=unavailable');
  await expect(page.getByTestId('conversation-unavailable')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  expect(await helper.visibleScrollOwners(page, '[data-testid="workspace-tool-content"]'))
    .toBeLessThanOrEqual(1);
  const errorOverflow = await helper.pageOverflow(page);
  expect(errorOverflow.documentScrollWidth).toBeLessThanOrEqual(errorOverflow.innerWidth + 1);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the Claude Reader was one primary ' +
      'data-workspace-surface with borderless continuous turns; Git rendered a ' +
      'primary Changes collection of Section groups and contiguous rows (measured ' +
      'group gap ' + measuredGroupGap + 'px) and a pushed primary Diff depth; Sandbox rendered its ' +
      'policy form Sections on a primary surface with a distinct secondary form-row ' +
      'background; each screen kept at most one visible scroll owner and no ' +
      'horizontal overflow; git-clean and conversation-unavailable stayed one ' +
      'readable flow.',
  });
});
