// #3075 SC-03: the expanded Sidebar keeps its search/filter, list scroll and
// selection while collapsed; the Terminal node and the Workspace surface
// context survive collapse/reopen and Project round trips; geometry changes go
// through the existing resize path instead of a remount.
import { expect, test, type Locator } from '@playwright/test';
import {
  freezeFixtureClock,
  gotoFixtureShell,
  waitForFixtureTerminal,
} from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function terminalMarker(page: import('@playwright/test').Page): Promise<string | null> {
  return page
    .getByTestId('terminal-surface')
    .evaluate((element) => (element as HTMLElement).dataset.sc03Marker ?? null);
}

async function columnWidth(page: import('@playwright/test').Page): Promise<number> {
  return (await page.getByTestId('sidebar-column').boundingBox())?.width ?? -1;
}

async function sidebarScroller(page: import('@playwright/test').Page): Promise<Locator> {
  return page
    .getByTestId('sidebar')
    .locator('[data-slot="scroll-area-viewport"]')
    .first();
}

test('SC-03: state, Terminal and Workspace context survive the rail round trip', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await freezeFixtureClock(page);
  // Short enough that the Session list really overflows and its scroll offset
  // is meaningful state rather than a trivially-zero reading.
  await page.setViewportSize({ width: 1280, height: 520 });
  await gotoFixtureShell(page);
  await waitForFixtureTerminal(page);

  // The mounted Terminal is identified before any navigation: a remount would
  // lose this marker.
  await page.getByTestId('terminal-surface').evaluate((element) => {
    (element as HTMLElement).dataset.sc03Marker = 'mounted';
  });

  // Workspace is a surface over the same mounted Terminal.
  await page.getByTestId('surface-action-open-workspace').click();
  await expect(page.getByTestId('surface-action-open-terminal')).toBeVisible();

  const scroller = await sidebarScroller(page);
  const scroll = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event('scroll'));
    return {
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    };
  });
  expect(scroll.max, 'the list is long enough to scroll').toBeGreaterThan(60);
  expect(scroll.top).toBeGreaterThan(60);

  const column = page.getByTestId('sidebar-column');
  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(() => columnWidth(page)).toBe(56);
  await page.getByTestId('sidebar-rail-expand').click();
  await expect.poll(() => columnWidth(page)).toBe(246);

  // The same list keeps its offset, and the Workspace surface context is
  // unchanged by the width round trip.
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scroll.top);
  await expect(page.getByTestId('surface-action-open-terminal')).toBeVisible();
  expect(await terminalMarker(page)).toBe('mounted');

  // Back on Terminal, collapsing only widens the display through the existing
  // resize path: the xterm node is the same and its box grows.
  await page.getByTestId('surface-action-open-terminal').click();
  const xterm = page.locator('.xterm').first();
  await expect(xterm).toBeVisible();
  await xterm.evaluate((element) => {
    (element as HTMLElement).dataset.sc03Xterm = 'same';
  });
  // The fixture pins the column count and fits its font to the well (the
  // product's build-config rule), so the geometry that must follow the column
  // is the terminal well's width, not a grid recomputation.
  const terminalWell = page.getByTestId('fixture-terminal');
  const widthExpanded = (await terminalWell.boundingBox())?.width ?? 0;
  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(() => columnWidth(page)).toBe(56);
  const widthCollapsed = (await terminalWell.boundingBox())?.width ?? 0;
  expect(widthCollapsed).toBeGreaterThan(widthExpanded + 100);
  expect(
    await xterm.evaluate((element) => (element as HTMLElement).dataset.sc03Xterm),
  ).toBe('same');

  // Search text and selection survive collapse/reopen in the mounted Sidebar.
  await page.getByTestId('sidebar-rail-search').click();
  const search = page.getByLabel('Search sessions');
  await expect(search).toBeFocused();
  await search.fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  const selectedBefore = await page
    .locator('[data-testid="session-item-row"][data-selected="true"]')
    .getAttribute('data-session-row');
  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(() => columnWidth(page)).toBe(56);
  await page.getByTestId('sidebar-rail-expand').click();
  await expect.poll(() => columnWidth(page)).toBe(246);
  await expect(search).toHaveValue('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  expect(
    await page
      .locator('[data-testid="session-item-row"][data-selected="true"]')
      .getAttribute('data-session-row'),
  ).toBe(selectedBefore);
  expect(await terminalMarker(page)).toBe('mounted');

  // Project round trip: open the standalone destination from the collapsed
  // rail, return through the selected Session, and prove both the Terminal and
  // the filter state were never reinitialized.
  await search.fill('');
  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(() => columnWidth(page)).toBe(56);
  await page.getByTestId('sidebar-rail-projects').click();
  await page.locator('[data-testid^="sidebar-rail-project-"]').first().click();
  await expect(page.getByTestId('web-project-detail')).toBeVisible();
  expect(await terminalMarker(page)).toBe('mounted');
  // The Session list is part of the collapsed column, so returning through
  // the selected Session first expands the rail.
  await page.getByTestId('sidebar-rail-expand').click();
  await expect.poll(() => columnWidth(page)).toBe(246);
  await page
    .locator('[data-testid="session-item-row"][data-selected="true"] button')
    .first()
    .click();
  await expect(page.getByTestId('web-project-detail')).toHaveCount(0);
  expect(await terminalMarker(page)).toBe('mounted');
  await expect(page.locator('.xterm').first()).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': list scrollTop ' + scroll.top + '/' + scroll.max +
      ', Workspace surface, search draft and selected Session survived the rail round trip; ' +
      'the same xterm node followed the terminal well from ' + widthExpanded + 'px to ' +
      widthCollapsed + 'px on collapse; Project round trip preserved the mounted Terminal',
  });
});
