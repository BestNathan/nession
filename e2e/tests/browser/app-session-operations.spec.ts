import { expect, test } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';

// App project/Session operation depths (#3089). Real tmux/agent stack — CI only.
const APP_URL =
  '/?token=e2e-test-token&server_url=' +
  encodeURIComponent('ws://localhost:19090/ws') +
  '&experience=app';

/**
 * The same owners as the Web dialog, composed as full-height operation pages:
 * Project create, then Project detail → New Session with child Location/ENV
 * depths that preserve the draft. Creating enters the created Session and its
 * attach presentation, then the Terminal shows the committed Project chip.
 */
test.describe('App Project and Session operation pages (#3089)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('creates a Project and a Session through the App operation depths', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    test.setTimeout(150_000);
    await page.goto(APP_URL);
    await waitForShell(page);

    await page.getByTestId('app-home-browse-sessions').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    const projectName = `e2e-app-project-${Date.now()}`;
    await page.getByTestId('project-create').click();
    const projectPage = page.getByTestId('app-project-create-page');
    await expect(projectPage).toBeVisible();
    await expect(projectPage.getByTestId('app-page-header')).toHaveCount(1);
    await projectPage.locator('#project-create-name').fill(projectName);
    await projectPage.getByTestId('project-location-add').click();
    await projectPage.locator('#project-create-location-path-0').fill('/tmp/nession-e2e');
    await projectPage.getByTestId('project-create-submit').click();
    await expect(page.getByTestId('project-detail-title')).toHaveText(projectName);

    await page.getByTestId('project-detail-create-session').click();
    const createPage = page.getByTestId('app-create-session-page');
    await expect(createPage).toBeVisible();
    await expect(createPage.getByTestId('app-page-header')).toHaveCount(1);
    const sessionName = `e2e-app-session-${Date.now()}`;
    await createPage.locator('#name').fill(sessionName);

    await createPage.getByTestId('app-session-location').click();
    const locationPage = page.getByTestId('app-create-location-page');
    await expect(locationPage).toBeVisible();
    await expect(locationPage.getByTestId('project-location-path')).toHaveText('/tmp/nession-e2e');
    await locationPage.getByTestId('app-create-location-0').click();
    await locationPage.getByTestId('app-create-location-done').click();
    await expect(createPage).toBeVisible();
    await expect(createPage.locator('#name')).toHaveValue(sessionName);

    await createPage.getByTestId('app-session-env').click();
    await expect(page.getByTestId('app-create-env-page')).toBeVisible();
    await page.getByTestId('app-create-env-done').click();
    await expect(createPage.locator('#name')).toHaveValue(sessionName);

    await createPage.getByTestId('create-session-submit').click();
    const sheet = page.getByTestId('app-attach-sheet');
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    const attachConfirm = page.getByTestId('app-attach-confirm');
    await expect(attachConfirm).toBeEnabled({ timeout: 20_000 });
    await attachConfirm.click();
    await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('terminal-surface')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('session-project-chip')).toHaveText(projectName, {
      timeout: 15_000,
    });
  });
});
