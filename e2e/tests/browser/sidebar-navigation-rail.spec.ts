// #3075 — the collapsed Web navigation rail.
//
// The rail is a reserved, in-flow 56px sibling of Main (not a floating
// control): geometry, purposeful shortcuts, draft-free creation, one search
// owner, an independent Project destination that preserves the Terminal, and
// the narrow/App boundary.
import { expect, test } from '@playwright/test';
import {
  freezeFixtureClock,
  gotoFixtureShell,
  waitForFixtureTerminal,
} from '../../helpers/fixtureVisual';

test.describe('Web navigation rail (#3075)', () => {
  test('reserves 56px in flow at 1024/1180/1280/1440 and never covers Main', async ({ page }) => {
    for (const width of [1024, 1180, 1280, 1440]) {
      await freezeFixtureClock(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/#/fixture');
      await waitForFixtureTerminal(page);

      const railWidth = await page.evaluate(() =>
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--nession-shell-rail-width',
          ),
        ),
      );
      expect(railWidth).toBe(56);

      const expanded = await page.getByTestId('sidebar-column').boundingBox();
      expect(expanded?.width).toBe(246);
      await page.getByTestId('sidebar-collapse').click();

      const column = page.getByTestId('sidebar-column');
      const rail = page.getByTestId('sidebar-rail');
      const main = page.locator('main');
      await expect.poll(async () => (await column.boundingBox())?.width ?? -1).toBe(railWidth);
      const railBox = await rail.boundingBox();
      const mainBox = await main.boundingBox();
      expect(railBox).not.toBeNull();
      expect(mainBox).not.toBeNull();
      // In-flow adjacency, not overlay: Main begins at the rail's right edge.
      expect(mainBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 0.5);
      expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(width + 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width + 1);
      // The wide floating reopen control is retired.
      await expect(page.getByTestId('sidebar-open')).toHaveCount(0);

      await page.getByTestId('sidebar-rail-expand').click();
      await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(246);
      const reExpandedMain = await main.boundingBox();
      expect((reExpandedMain?.x ?? 0) + (reExpandedMain?.width ?? 0)).toBeLessThanOrEqual(width + 0.5);
    }
  });

  test('shortcuts reuse the existing create, search and Project owners', async ({ page }) => {
    await freezeFixtureClock(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoFixtureShell(page);
    await waitForFixtureTerminal(page);

    const terminal = page.getByTestId('terminal-surface');
    await terminal.evaluate((element) => {
      (element as HTMLElement).dataset.railMarker = 'kept';
    });
    await page.getByTestId('sidebar-collapse').click();
    const rail = page.getByTestId('sidebar-rail');

    // New Session opens the existing create dialog; it does not create.
    await rail.getByTestId('sidebar-rail-new-session').click();
    await expect(page.getByTestId('create-session-dialog')).toBeVisible();
    await page.getByTestId('create-session-dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('create-session-dialog')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-rail')).toBeVisible();

    // Search expands the column and focuses the one canonical field.
    await rail.getByTestId('sidebar-rail-search').click();
    await expect(page.getByLabel('Search sessions')).toBeFocused();
    await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
    await page.getByLabel('Search sessions').fill('design');
    await expect(page.getByTestId('session-item-row')).toHaveCount(1);
    // The Project return path picks the selected row, which the filter above
    // excluded; clear it so the destination returns through that Session.
    await page.getByLabel('Search sessions').fill('');

    // Projects is present only with a navigable destination, and opens the
    // standalone Project detail without unmounting the Terminal.
    await page.getByTestId('sidebar-collapse').click();
    await page.getByTestId('sidebar-rail-projects').click();
    const projectItem = page.locator('[data-testid^="sidebar-rail-project-"]').first();
    await expect(projectItem).toBeVisible();
    await projectItem.click();
    await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
    await expect(page.getByTestId('web-project-detail')).toBeVisible();
    await expect(page.getByTestId('terminal-surface')).toBeVisible();
    expect(
      await page
        .getByTestId('terminal-surface')
        .evaluate((element) => (element as HTMLElement).dataset.railMarker),
    ).toBe('kept');

    // Return through the selected Session: expand the rail, then pick the
    // still-selected row. The same Terminal node survives.
    await page.getByTestId('sidebar-rail-expand').click();
    await expect
      .poll(
        async () =>
          (await page.getByTestId('sidebar-column').boundingBox())?.width ?? 0,
      )
      .toBe(246);
    await page.locator('[data-testid="session-item-row"][data-selected="true"] button').first().click();
    await expect(page.getByTestId('web-project-detail')).toHaveCount(0);
    expect(
      await page
        .getByTestId('terminal-surface')
        .evaluate((element) => (element as HTMLElement).dataset.railMarker),
    ).toBe('kept');

    // Server status is a passive signal, never a button.
    await page.getByTestId('sidebar-collapse').click();
    const status = page.getByTestId('sidebar-rail-server');
    await expect(status).toHaveAttribute('role', 'img');
    await expect(status).toHaveAttribute('aria-label', 'Server connected');
  });

  test('narrow Web and App never reserve the rail', async ({ page }) => {
    await freezeFixtureClock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/fixture?experience=web');
    await expect(page.getByTestId('session-drawer-panel')).toBeVisible();
    await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);

    await page.goto('/#/fixture/app');
    await expect(page.getByTestId('app-layer-root')).toBeVisible();
    await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  });
});
