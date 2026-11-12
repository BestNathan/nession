'use strict';
// #3025 SC-04: Web Sidebar and the App Sessions layer expose selectable
// Projects and open an independent ProjectDetail with Source, Existing
// Locations, EROFS image reference and Existing/Managed create operations.
// Loading, error, retry, offline and return states remain explicit; the flat
// Session list never gains a Project parent.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-04: Web Projects open a standalone detail and return to the Terminal', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);

  const selected = page.locator('[data-testid="session-item-row"][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  const selectedSession = await selected.getAttribute('data-session-row');

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  await expect(page.getByTestId('project-source-ref')).toHaveText('main');
  await expect(page.getByTestId('project-location-row')).toHaveCount(1);
  await expect(page.getByTestId('project-image-digest')).toContainText('sha256:');
  await expect(page.getByTestId('project-detail-create-session')).toBeVisible();
  // The Project is a sibling destination: the Session row stays selected and
  // no Project parent row is added to the flat Session list.
  await expect(selected).toHaveCount(1);
  expect(await selected.getAttribute('data-session-row')).toBe(selectedSession);

  // Managed is present but fails closed; no Native Session is substituted.
  await page.getByTestId('project-detail-managed-session').click();
  const managed = page.getByTestId('project-managed-unavailable');
  await expect(managed).toBeVisible();
  await expect(managed).toContainText('no Native fallback was attempted');
  await page.keyboard.press('Escape');
  await expect(managed).toHaveCount(0);
  await expect(page.getByTestId('session-item-row')).toHaveCount(6);

  // Existing creation opens from the standalone detail.
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('project-location-offline')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Return through the ordinary Session selection path.
  await page.getByTestId('session-item-row').first().getByRole('button').first().click();
  await expect(page.getByTestId('project-detail')).toHaveCount(0);
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web 1440x900 showed two selectable Projects beside the flat ' +
      'Session list; opening Nession kept the selected Session ' + selectedSession +
      ' and rendered Source ref main, one Existing Location and the sha256 image digest; ' +
      'Managed failed closed with no Native fallback and no new Session row; Existing ' +
      'creation opened; selecting a Session returned to the Terminal with the detail gone',
  });
});

test('SC-04: App pushes ProjectDetail from Sessions with one header and Back', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?projects=canonical');
  await page.getByTestId('app-header-sessions').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('app-project-detail')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  // Exactly one host-owned page header at this depth.
  await expect(page.getByTestId('app-page-header')).toHaveCount(1);
  // The Terminal stays mounted under the Sessions layer.
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();

  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(page.getByTestId('app-project-detail')).toHaveCount(0);
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': App 390x844 pushed Nession detail from Sessions with exactly ' +
      'one page header and the Terminal still mounted; Back returned to the Sessions layer ' +
      'with both Project rows and the Terminal intact',
  });
});

test('SC-04: the loading state is visible before the list resolves', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/#/fixture?projects=loading');
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByText(/Loading Projects/)).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': an unresolved Project list rendered the explicit loading status',
  });
});

test('SC-04: empty and error/retry states are explicit', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/#/fixture?projects=empty');
  await expect(page.getByTestId('projects-empty')).toHaveText('No Projects yet');
  await expect(page.getByTestId('project-create')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('projects-empty')).toHaveText('No Projects yet');

  await page.goto('/#/fixture?projects=error');
  await page.reload();
  await expect(page.getByTestId('projects-error')).toHaveText('Projects could not be loaded');
  const before = await page.evaluate(() => window.fixtureProjects.listRequests());
  expect(before).toBeGreaterThan(0);
  await page.getByTestId('projects-retry').click();
  await expect.poll(() => page.evaluate(() => window.fixtureProjects.listRequests()))
    .toBeGreaterThan(before);
  await expect(page.getByTestId('projects-error')).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Projects rendered the empty state with an enabled create action ' +
      'and the error state; Retry issued a fresh list read and kept the explicit error visible',
  });
});

test('SC-04: an offline Existing Location is explicit and disables creation', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/#/fixture?projects=offline');
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const offline = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
  await expect(offline.getByTestId('project-location-offline')).toBeVisible();
  await expect(offline.getByTestId('create-session-submit')).toBeDisabled();

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': an offline Existing Location was shown explicitly in the ' +
      'Project create dialog and disabled Session creation',
  });
});
