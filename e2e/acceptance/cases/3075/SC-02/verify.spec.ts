// #3075 SC-02: exactly one Expand plus distinct purposeful shortcuts, each with
// action-specific outcomes, accessible labels/focus/tooltip. New opens (but does
// not submit) create; Search expands/focuses the existing search; Projects
// appears only when navigable and preserves the current Session; the Server
// status is truthful and non-actionable.
import { expect, test } from '@playwright/test';
import {
  freezeFixtureClock,
  gotoFixtureShell,
  waitForFixtureTerminal,
} from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

test('SC-02: rail shortcuts delegate to the existing owners and are never dead', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoFixtureShell(page);
  await waitForFixtureTerminal(page);

  await page.getByTestId('sidebar-collapse').click();
  const rail = page.getByTestId('sidebar-rail');
  await expect(rail).toBeVisible();

  // Exactly one Expand, and every icon-only control names itself.
  await expect(rail.getByTestId('sidebar-rail-expand')).toHaveCount(1);
  await expect(rail.getByTestId('sidebar-rail-expand')).toHaveAttribute(
    'aria-label',
    'Expand sidebar',
  );
  await expect(rail.getByTestId('sidebar-rail-expand')).toHaveAttribute(
    'title',
    'Expand sidebar',
  );
  await expect(rail.getByTestId('sidebar-rail-new-session')).toHaveAttribute(
    'aria-label',
    'New Session',
  );
  await expect(rail.getByTestId('sidebar-rail-new-session')).toHaveAttribute(
    'title',
    'New Session',
  );
  await expect(rail.getByTestId('sidebar-rail-search')).toHaveAttribute(
    'aria-label',
    'Search sessions',
  );
  await expect(rail.getByTestId('sidebar-rail-search')).toHaveAttribute(
    'title',
    'Search sessions',
  );

  // The Server status is passive: a labelled image, not a control.
  const status = page.getByTestId('sidebar-rail-server');
  await expect(status).toHaveAttribute('role', 'img');
  await expect(status).toHaveAttribute('aria-label', 'Server connected');
  expect(await status.evaluate((element) => element.tagName)).toBe('SPAN');

  // New Session opens the existing create flow and creates nothing by itself.
  const rowsBefore = await page.getByTestId('session-item-row').count();
  await rail.getByTestId('sidebar-rail-new-session').click();
  await expect(page.getByTestId('create-session-dialog')).toBeVisible();
  await page
    .getByTestId('create-session-dialog')
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.getByTestId('create-session-dialog')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-rail')).toBeVisible();
  expect(await page.getByTestId('session-item-row').count()).toBe(rowsBefore);

  // Search expands the column and focuses the one canonical Session search.
  await rail.getByTestId('sidebar-rail-search').click();
  await expect(page.getByTestId('sidebar-rail')).toHaveCount(0);
  const search = page.getByLabel('Search sessions');
  await expect(search).toBeFocused();
  await expect(search).toHaveCount(1);
  await search.fill('design');
  await expect(page.getByTestId('session-item-row')).toHaveCount(1);
  await search.fill('');

  // Mark the mounted Terminal before the Project round trip, so a remount
  // would lose the marker rather than acquire it afterwards.
  await page
    .getByTestId('terminal-surface')
    .evaluate((element) => {
      (element as HTMLElement).dataset.sc02Marker = 'kept';
    });

  // Projects is present because a navigable destination exists.
  await page.getByTestId('sidebar-collapse').click();
  const projects = page.getByTestId('sidebar-rail-projects');
  await expect(projects).toHaveAttribute('aria-label', 'Projects');
  await projects.click();
  const projectItem = page
    .locator('[data-testid^="sidebar-rail-project-"]')
    .first();
  await expect(projectItem).toBeVisible();
  await projectItem.click();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  await expect(page.getByTestId('web-project-detail')).toBeVisible();
  await expect(page.getByTestId('terminal-surface')).toBeVisible();

  // Returning through the selected Session closes the Project destination and
  // keeps the same mounted Terminal node.
  await page
    .locator('[data-testid="session-item-row"][data-selected="true"] button')
    .first()
    .click();
  await expect(page.getByTestId('web-project-detail')).toHaveCount(0);
  expect(
    await page
      .getByTestId('terminal-surface')
      .evaluate((element) => (element as HTMLElement).dataset.sc02Marker),
  ).toBe('kept');

  // Re-expand from the still-collapsed rail, then collapse again for the
  // keyboard path: Expand is focusable and Enter performs the expansion,
  // returning focus to the column's collapse action.
  await page.getByTestId('sidebar-rail-expand').click();
  await expect
    .poll(async () => (await page.getByTestId('sidebar-column').boundingBox())?.width ?? 0)
    .toBe(246);
  await page.getByTestId('sidebar-collapse').click();
  const expand = page.getByTestId('sidebar-rail-expand');
  await expand.focus();
  await expect(expand).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await page.getByTestId('sidebar-column').boundingBox())?.width ?? 0)
    .toBe(246);
  await expect(page.getByTestId('sidebar-collapse')).toBeFocused();

  // No dead shortcut when Projects are not navigable.
  await page.goto('/#/fixture?projects=empty');
  await page.getByTestId('shell').waitFor();
  await waitForFixtureTerminal(page);
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-rail')).toBeVisible();
  await expect(page.getByTestId('sidebar-rail-projects')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': one labelled Expand/New/Search; New opened the create dialog ' +
      'without creating; Search focused the single existing field; Projects opened independent ' +
      'ProjectDetail and preserved the Terminal node; status role=img; no Projects shortcut with ' +
      'projects=empty',
  });
});
