'use strict';
// #3387 SC-02: in the real rendered Web Sidebar and the narrow App Sessions
// Project list, a mutation's newer refresh stays visible after the older list
// settles, and the current Session/Terminal selection survives.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

function pendingLists(page) {
  return page.evaluate(() => window.fixtureProjects?.pendingLists() ?? -1);
}

async function waitForPendingLists(page, count) {
  await expect.poll(() => pendingLists(page)).toBe(count);
}

async function releaseLatest(page) {
  await page.evaluate(() => window.fixtureProjects.releaseLatestList());
}

async function releaseOldest(page) {
  await page.evaluate(() => window.fixtureProjects.releaseOldestList());
}

async function startOlderRead(page) {
  await page.evaluate(() => window.fixtureProjects.refresh());
  await waitForPendingLists(page, 1);
}

test.describe('Web Project list ordering', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('SC-02: an older list cannot undo create, rename or delete on the Web Sidebar', async ({ page }, testInfo) => {
    test.setTimeout(100_000);
    page.setDefaultTimeout(15_000);
    const { sha } = verifiedRuntime('SC-02');

    await page.goto('/#/fixture?projects=stale-list');
    await expect(page.getByTestId('projects-section')).toBeVisible();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);
    await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();

    // The mount read A is held by the fixture.
    await waitForPendingLists(page, 1);

    // ── Create: its refresh B settles first, then A arrives late ──
    await page.getByTestId('project-create').click();
    const createDialog = page.getByRole('dialog').filter({ hasText: 'Create Project' });
    await createDialog.locator('#project-create-name').fill('Race Created');
    await createDialog.getByTestId('project-create-submit').click();
    await waitForPendingLists(page, 2);
    await releaseLatest(page);
    await expect(page.getByTestId('project-detail-title')).toHaveText('Race Created');
    await expect(page.getByTestId('project-item-row')).toHaveCount(3);
    await releaseOldest(page);
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'Race Created' }))
      .toHaveCount(1);
    await expect(page.getByTestId('project-item-row')).toHaveCount(3);

    const created = page.getByTestId('project-item-row').filter({ hasText: 'Race Created' });
    const projectId = await created.getAttribute('data-project-id');
    expect(projectId).toBeTruthy();

    // ── Rename: hold a pre-rename read, settle the rename refresh first ──
    await startOlderRead(page);
    await page.getByTestId(`project-actions-${projectId}`).click();
    await page.getByTestId(`project-actions-rename-${projectId}`).click();
    const renameDialog = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
    await renameDialog.locator('#project-rename-name').fill('Race Renamed');
    await renameDialog.getByTestId('project-rename-submit').click();
    await waitForPendingLists(page, 2);
    await releaseLatest(page);
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'Race Renamed' }))
      .toHaveCount(1);
    await releaseOldest(page);
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'Race Renamed' }))
      .toHaveCount(1);
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'Race Created' }))
      .toHaveCount(0);

    // ── Delete: a pre-delete answer must not resurrect the Project ──
    await startOlderRead(page);
    await page.getByTestId(`project-actions-${projectId}`).click();
    await page.getByTestId(`project-actions-delete-${projectId}`).click();
    await page.getByTestId('project-delete-confirm').click();
    await waitForPendingLists(page, 2);
    await releaseLatest(page);
    await expect(page.getByTestId('project-item-row')).toHaveCount(2);
    await releaseOldest(page);
    await expect(page.getByTestId('project-item-row')).toHaveCount(2);
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'Race Renamed' }))
      .toHaveCount(0);

    await expect(page.getByTestId('session-item-row')).toHaveCount(6);
    await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();

    testInfo.annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ' at 1440x900: create/rename/delete refreshes settled before ' +
        'their older Project list answers; the new or renamed Project stayed visible and the ' +
        'deleted one stayed gone; the Session selection and Terminal were unchanged',
    });
  });
});

test.describe('App Project list ordering', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('SC-02: a stale list does not replace the App Project list or Terminal', async ({ page }, testInfo) => {
    test.setTimeout(100_000);
    page.setDefaultTimeout(15_000);
    const { sha } = verifiedRuntime('SC-02');

    await page.goto('/#/fixture/app?projects=stale-list');
    await page.getByTestId('app-header-sessions').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);
    await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);
    await waitForPendingLists(page, 1);

    await page.getByTestId('project-create').click();
    const createPage = page.getByTestId('app-project-create-page');
    await expect(createPage).toBeVisible();
    await createPage.locator('#project-create-name').fill('App Race');
    await createPage.getByTestId('project-create-submit').click();
    await waitForPendingLists(page, 2);
    await releaseLatest(page);
    await expect(page.getByTestId('app-project-detail')).toBeVisible();
    await expect(page.getByTestId('project-detail-title')).toHaveText('App Race');
    await releaseOldest(page);

    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'App Race' }))
      .toHaveCount(1);
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();
    await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);

    testInfo.annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ' at 390x844: the App Sessions Project create refresh settled ' +
        'before the older list; the created Project stayed in the App list and the Terminal ' +
        'and Session selection were unchanged',
    });
  });
});
