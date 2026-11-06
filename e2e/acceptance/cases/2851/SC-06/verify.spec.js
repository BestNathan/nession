'use strict';
// #2851 SC-06: the implemented Sidebar renders the approved Nession metrics at
// canonical Web viewports, with accessible representative states.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function measure(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    };
    const style = (selector, properties) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const computed = getComputedStyle(element);
      return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]));
    };
    const row = document.querySelector('[data-testid="session-item-row"]');
    return {
      column: rect('[data-testid="sidebar-column"]'),
      collapse: rect('[data-testid="sidebar-collapse"]'),
      create: rect('[data-testid="create-session"]'),
      search: rect('[data-testid="session-list-header"] input'),
      title: style('[data-testid="session-item-title"]', ['font-size', 'font-weight', 'line-height']),
      meta: style('[data-testid="session-item-meta"]', ['font-size', 'font-weight', 'line-height']),
      row: row ? {
        radius: getComputedStyle(row).borderRadius,
        padTop: getComputedStyle(row).paddingTop,
        padBottom: getComputedStyle(row).paddingBottom,
      } : null,
      dot: rect('[data-testid="sidebar-server-dot"]'),
      selected: document.querySelectorAll('[data-testid="session-item-row"][data-selected="true"]').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`SC-06: approved Sidebar metrics at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(180_000);
    const { sha } = verifiedRuntime('SC-06');
    await page.setViewportSize(viewport);
    await page.clock.install({ time: new Date('2026-09-01T12:00:00Z') });
    await page.goto('/#/fixture');
    await page.getByTestId('session-item-row').first().waitFor();
    const metrics = await measure(page);

    expect(metrics.column?.width).toBe(246);
    expect(metrics.collapse).toEqual({ width: 36, height: 36 });
    expect(metrics.create?.height).toBe(36);
    expect(metrics.search?.height).toBe(36);
    expect(metrics.title).toEqual({ 'font-size': '14px', 'font-weight': '550', 'line-height': '18.2px' });
    expect(metrics.meta).toEqual({ 'font-size': '11.5px', 'font-weight': '475', 'line-height': '14.95px' });
    expect(metrics.row).toEqual({ radius: '7px', padTop: '7px', padBottom: '7px' });
    expect(metrics.dot).toEqual({ width: 5, height: 5 });
    expect(metrics.selected).toBe(1);
    expect(metrics.overflow).toBeLessThanOrEqual(1);

    await expect(page.getByLabel('Search sessions')).toBeVisible();
    await expect(page.getByTestId('sidebar-collapse')).toHaveAccessibleName('Collapse sidebar');
    await expect(page.getByTestId('session-item-row').filter({ hasText: 'fix-terminal-reconnect' })).toHaveCount(1);
    const selected = page.locator('[data-testid="session-item-row"][data-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected.getByTestId('session-item-title')).toHaveText('fix-terminal-reconnect');

    await page.keyboard.press('Tab');
    const collapse = page.getByTestId('sidebar-collapse');
    await expect(collapse).toBeFocused();
    expect(await collapse.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    expect(await collapse.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('2px');

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ' at ' + viewport.width + 'x' + viewport.height + ': measured 246px column, ' +
        '36px collapse/create/search controls, 14px/550/18.2px titles, 11.5px/475/14.95px metadata, ' +
        '7px row radius and padding, 5px status mark, one selected row, no overflow, and a keyboard-focused ' +
        'collapse control with a 2px focus outline',
    });
  });
}
