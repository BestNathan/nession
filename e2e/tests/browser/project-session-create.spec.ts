import { expect, test } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';

// Real-stack creation and the fixture's offline branch. Browser execution is
// CI-only by the repository's E2E policy.
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Project Existing-location Session creation', () => {
  test('creates a Session from the declared Existing Location', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    test.setTimeout(90_000);
    await page.goto(
      '/?token=e2e-test-token&server_url=' +
        encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);

    // The agent must have registered before a location can name it.
    const createButton = page.getByTestId('create-session');
    await expect(createButton).toBeEnabled({ timeout: 60_000 });

    const projectName = `e2e-project-${Date.now()}`;
    await page.getByTestId('project-create').click();
    const projectDialog = page.getByRole('dialog').filter({ hasText: 'Create Project' });
    await expect(projectDialog).toBeVisible();
    await projectDialog.locator('#project-create-name').fill(projectName);
    await projectDialog.getByTestId('project-location-add').click();
    await projectDialog.locator('#project-create-location-path-0').fill('/tmp/nession-e2e');
    await projectDialog.getByTestId('project-create-submit').click();

    await expect(page.getByTestId('project-detail-title')).toHaveText(projectName);
    await page.getByTestId('project-detail-create-session').click();

    const sessionDialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
    await expect(sessionDialog).toBeVisible();
    const sessionName = `e2e-project-session-${Date.now()}`;
    await sessionDialog.locator('#name').fill(sessionName);
    await sessionDialog.getByTestId('create-session-submit').click();

    // The created Session appears in the flat list; the Project remains a
    // declaration, not a parent of that row.
    await expect(
      page.locator('[data-testid="session-item-row"]', { hasText: sessionName }),
    ).toBeVisible({ timeout: 15_000 });

    // Creating enters the work (the ordinary selection path); a freshly made
    // Session has no stored attach profile, so confirm its attach prompt. The
    // Project chip is terminal-capsule chrome — it exists once the Terminal
    // surface is attached — and it carries the membership the create
    // committed, projected through create/list.
    const attachDialog = page.getByRole('dialog').filter({ hasText: 'Attach' });
    await expect(attachDialog).toBeVisible({ timeout: 10_000 });
    const attachButton = attachDialog.getByRole('button', { name: 'Attach' });
    await expect(attachButton).toBeEnabled({ timeout: 10_000 });
    await attachButton.click();
    await expect(attachDialog).not.toBeVisible({ timeout: 5_000 });

    await expect(page.getByTestId('session-project-chip')).toHaveText(projectName, {
      timeout: 30_000,
    });
  });

  test('an offline Existing Location is explicit and cannot create', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto('/#/fixture?projects=offline');
    await page.getByTestId('project-item-row').first().click();
    await page.getByTestId('project-detail-create-session').click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
    await expect(dialog.getByTestId('project-location-offline')).toBeVisible();
    await expect(dialog.getByTestId('create-session-submit')).toBeDisabled();
  });
});
