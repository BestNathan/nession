// #2851 — the Session-first Web sidebar.
//
// The fixture is the real Web composition with deterministic data. These tests
// measure the shipped geometry and drive the interactions the Requirement calls
// out: search/select/filter, the overflow actions, full tuck-away with the
// Terminal still mounted, the explicit narrow-Web drawer, and the separation
// between Agent context and Server status.
import { expect, test, type Page } from '@playwright/test';
import {
  freezeFixtureClock,
  gotoFixtureApp,
  gotoFixtureShell,
  waitForFixtureTerminal,
} from '../../helpers/fixtureVisual';

async function openSidebarFixture(
  page: Page,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
  search = '',
): Promise<void> {
  await freezeFixtureClock(page);
  await page.setViewportSize(viewport);
  await page.goto(`/#/fixture${search}`);
  await expect(page.getByTestId('session-item-row').first()).toBeVisible();
}

async function sidebarMetrics(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const style = (selector: string, properties: string[]) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const computed = getComputedStyle(element);
      return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]));
    };
    const row = document.querySelector('[data-testid="session-item-row"]');
    return {
      column: rect('[data-testid="sidebar-column"]'),
      topActions: rect('[data-testid="sidebar-top-actions"]'),
      collapse: rect('[data-testid="sidebar-collapse"]'),
      create: rect('[data-testid="create-session"]'),
      search: rect('[data-testid="session-list-header"] input'),
      title: style('[data-testid="session-item-title"]', ['font-size', 'font-weight', 'line-height']),
      meta: style('[data-testid="session-item-meta"]', ['font-size', 'font-weight', 'line-height']),
      row: row
        ? {
            radius: getComputedStyle(row).borderRadius,
            padTop: getComputedStyle(row).paddingTop,
            padBottom: getComputedStyle(row).paddingBottom,
          }
        : null,
      statusDot: rect('[data-testid="sidebar-server-dot"]'),
      selected: document.querySelectorAll('[data-testid="session-item-row"][data-selected="true"]').length,
      agentsVisible: Boolean(document.querySelector('[data-testid="sidebar-agents"]')),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`Session-first composition and metrics at ${viewport.width}`, async ({ page }) => {
    await openSidebarFixture(page, viewport);
    const metrics = await sidebarMetrics(page);

    expect(metrics.column?.width).toBe(246);
    expect(metrics.topActions?.height).toBe(52);
    expect(metrics.collapse).toMatchObject({ width: 36, height: 36 });
    expect(metrics.create?.height).toBe(36);
    expect(metrics.search?.height).toBe(36);
    expect(metrics.title).toEqual({
      'font-size': '14px',
      'font-weight': '550',
      'line-height': '18.2px',
    });
    expect(metrics.meta).toEqual({
      'font-size': '11.5px',
      'font-weight': '475',
      'line-height': '14.95px',
    });
    expect(metrics.row).toEqual({ radius: '7px', padTop: '7px', padBottom: '7px' });
    expect(metrics.statusDot).toMatchObject({ width: 5, height: 5 });
    expect(metrics.selected).toBe(1);
    expect(metrics.agentsVisible).toBe(false);
    expect(metrics.overflow).toBeLessThanOrEqual(1);

    // The top begins with the shell toggle and explicit creation, and the
    // Agent roster is not above the Session list.
    await expect(page.getByTestId('sidebar-top-actions').getByTestId('create-session')).toBeVisible();
    await expect(page.getByTestId('sidebar-top-actions').getByTestId('sidebar-collapse')).toBeVisible();
    await expect(page.getByTestId('sidebar-agents-entry')).toBeVisible();
    await expect(page.getByTestId('sidebar-agents')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-session-count')).toHaveText('6');
    await expect(page.getByTestId('session-group-label')).toHaveText([
      'Today',
      'Previous 7 days',
      'Older',
    ]);
    await expect(page.getByTestId('create-session')).toBeEnabled();
  });
}

test('search, selection, actions and empty states are operable (#2851 SC-02)', async ({ page }) => {
  await openSidebarFixture(page);

  const search = page.getByLabel('Search sessions');
  await search.fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await expect(page.getByTestId('session-item-title')).toHaveText('design-system');

  await search.fill('no-such-session');
  await expect(page.getByTestId('session-search-miss')).toContainText('No sessions match “no-such-session”');
  await page.getByTestId('session-search-clear').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  await page.getByTestId('session-list-filters').click();
  await page.getByTestId('session-list-filters-panel').getByRole('button', { name: 'Offline' }).click();
  await expect(page.getByTestId('session-list-filter-chip')).toContainText('Offline');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await expect(page.getByTestId('session-item-row')).toContainText('prod-shell');
  await page.getByTestId('session-list-filter-chip').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  await page.getByTestId('session-item-devbox-01:design-system').click();
  const selected = page.locator('[data-testid="session-item-row"][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected.getByTestId('session-item-title')).toHaveText('design-system');
  await expect(page.getByTestId('session-item-devbox-01:design-system')).toHaveAttribute('aria-current', 'true');

  const actions = page.getByTestId('session-actions-devbox-01:design-system');
  await actions.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await page.goto('/#/fixture?sessions=none');
  await page.reload();
  await expect(page.getByTestId('session-item-row')).toHaveCount(0);
  await expect(page.getByText('No sessions yet. Select New Session to get started.')).toBeVisible();
  await expect(page.getByTestId('create-session')).toBeEnabled();

  await page.goto('/#/fixture?agents=offline');
  await page.reload();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await page.getByTestId('session-list-filters').click();
  await page.getByTestId('session-list-filters-panel').getByRole('button', { name: 'Online' }).click();
  await expect(page.getByTestId('session-search-miss')).toContainText('No sessions match this filter.');
  await page.getByTestId('session-filter-clear').click();
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.getByTestId('create-session')).toBeDisabled();
});

test('collapse returns 246px to the work surface and preserves state (#2851 SC-03)', async ({ page }) => {
  await openSidebarFixture(page, { width: 1440, height: 480 });
  await waitForFixtureTerminal(page);

  await page.getByTestId('session-item-devbox-01:design-system').click();
  await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toContainText(
    'design-system',
  );

  // A short viewport makes the history genuinely scrollable; collapsing and
  // reopening must leave the same scroll offset, not reset the list.
  const viewport = page.locator('[data-testid="sidebar"] [data-slot="scroll-area-viewport"]').first();
  await expect(viewport).toBeVisible();
  const scrollable = await viewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
  await viewport.evaluate((element) => {
    element.scrollTop = 40;
  });
  const scrollBefore = await viewport.evaluate((element) => element.scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  const column = page.getByTestId('sidebar-column');
  const main = page.getByTestId('main-content');
  const terminal = page.locator('.xterm').first();
  const expanded = (await column.boundingBox())?.width ?? 0;
  const expandedMain = (await main.boundingBox())?.width ?? 0;
  await main.evaluate((element) => {
    (element as HTMLElement).dataset.marker = 'kept';
  });

  await page.getByTestId('sidebar-collapse').click();
  await expect.poll(async () => (await column.boundingBox())?.width ?? -1).toBe(0);
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  const open = page.getByTestId('sidebar-open');
  await expect(open).toBeVisible();
  const openBox = await open.boundingBox();
  expect(openBox?.width).toBe(36);
  expect(openBox?.height).toBe(36);
  await expect.poll(async () => (await main.boundingBox())?.width ?? 0).toBeGreaterThan(
    expandedMain + expanded * 0.9,
  );
  const marker = await main.evaluate((element) => (element as HTMLElement).dataset.marker);
  expect(marker).toBe('kept');
  await expect(terminal).toBeVisible();

  await page.getByTestId('sidebar-open').click();
  await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(expanded);
  await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toContainText(
    'design-system',
  );
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollBefore);

  const search = page.getByLabel('Search sessions');
  await search.fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await page.getByTestId('sidebar-collapse').click();
  await expect(open).toBeVisible();
  await page.getByTestId('sidebar-open').click();
  await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(expanded);
  await expect(page.getByLabel('Search sessions')).toHaveValue('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
});

test('narrow Web uses the overlay drawer and App stays spatial (#2851 SC-04)', async ({ page }) => {
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture?experience=web');
  await expect(page.getByTestId('session-drawer-panel')).toBeVisible();
  await page.waitForTimeout(350);
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  expect(
    await page.getByTestId('session-drawer-panel').evaluate((element) => element.getBoundingClientRect().x),
  ).toBe(0);

  await page.getByTestId('sidebar-drawer-close').click();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  const open = page.getByTestId('session-drawer-open');
  await expect(open).toBeVisible();
  const openBox = await open.boundingBox();
  expect(openBox?.width).toBe(36);
  expect(openBox?.height).toBe(36);

  await open.click();
  await expect(page.getByTestId('session-drawer-panel')).toBeVisible();
  await page.getByTestId('session-item-devbox-01:design-system').click();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  await open.click();
  await expect(page.getByTestId('session-item-devbox-01:design-system')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);

  await gotoFixtureApp(page);
  await expect(page.getByTestId('app-layer-root')).toBeVisible();
  await expect(page.getByTestId('sidebar-column')).toHaveCount(0);
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
});

test('Agent detail and Server status stay separate dimensions (#2851 SC-05)', async ({ page }) => {
  await openSidebarFixture(page, { width: 1440, height: 900 }, '?agents=offline');
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  await expect(page.getByTestId('create-session')).toBeDisabled();
  await expect(page.getByTestId('sidebar-agents')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-server-status')).toHaveText('Server connected');
  await expect(page.getByTestId('sidebar-server-dot')).not.toHaveClass(/destructive/);
  await expect(page.getByTestId('session-item-devbox-01:fix-terminal-reconnect')).toContainText(
    'Agent offline',
  );

  await page.getByTestId('sidebar-agents-entry').click();
  await expect(page.getByTestId('sidebar-agents-panel')).toBeVisible();
  await expect(page.getByTestId('sidebar-agents')).toBeVisible();
  await expect(page.getByTestId('sidebar-agent-sg-prod')).toBeVisible();
  await expect(page.getByTestId('sidebar-server-status')).toHaveText('Server connected');
});
