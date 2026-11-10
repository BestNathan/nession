import { expect, test, type Page } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';

// App Attach presentation (#3089). Real tmux/agent stack — CI only.
const APP_URL =
  '/?token=e2e-test-token&server_url=' +
  encodeURIComponent('ws://localhost:19090/ws') +
  '&experience=app';

/**
 * The selected-regression plan may run this spec without another spec that
 * creates a Session first. A row-action attach test cannot depend on shared
 * suite order: create one through the App's own New Session depth when the
 * runtime starts empty, close the resulting attach sheet, and return to the
 * Sessions surface.
 */
async function ensureSessionRow(page: Page): Promise<void> {
  const actions = page.locator('[data-testid^="session-actions-"]');
  if ((await actions.count()) > 0) return;

  await page.getByTestId('create-session').click();
  const createPage = page.getByTestId('app-create-session-page');
  await expect(createPage).toBeVisible();
  await createPage.locator('#name').fill(`e2e-attach-${Date.now()}`);
  const submit = createPage.getByTestId('create-session-submit');
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click();

  const sheet = page.getByTestId('app-attach-sheet');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await page.goto(APP_URL);
  await waitForShell(page);
  await page.getByTestId('app-home-browse-sessions').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(actions.first()).toBeVisible({ timeout: 20_000 });
}

/**
 * The same attach owner as Web, composed as the App quick sheet and a
 * full-height configuration depth. Selecting a Session opens the sheet; the
 * sheet's Attach is the only action that attaches. The row's Attach settings
 * opens the configuration directly and its one action saves without attaching.
 */
test.describe('App Attach presentation (#3089)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('quick sheet, settings depth and Back preserve the attach intent', async ({ page }) => {
    test.skip(!process.env.CI, 'real tmux/agent stack runs in CI');
    test.setTimeout(90_000);
    await page.goto(APP_URL);
    await waitForShell(page);

    await page.getByTestId('app-home-browse-sessions').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await ensureSessionRow(page);
    await page.locator('button[data-testid^="session-item-"]').first().click();

    const sheet = page.getByTestId('app-attach-sheet');
    await expect(sheet).toBeVisible();
    const attachConfirm = page.getByTestId('app-attach-confirm');
    await expect(attachConfirm).toBeEnabled({ timeout: 20_000 });

    await page.getByTestId('app-attach-settings-entry').click();
    const settings = page.getByTestId('app-attach-settings-page');
    await expect(settings).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toHaveCount(1);
    await expect(settings).toContainText('Connection mode');

    await page.getByTestId('attach-mode-p2p').click();
    await page.getByTestId('app-page-back').click();
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('attach-mode-summary')).toContainText('Direct P2P connection');

    await attachConfirm.click();
    await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('terminal-surface')).toBeVisible({ timeout: 20_000 });
  });

  test('explicit Attach settings saves without attaching', async ({ page }) => {
    test.skip(!process.env.CI, 'real tmux/agent stack runs in CI');
    test.setTimeout(60_000);
    await page.goto(APP_URL);
    await waitForShell(page);

    await page.getByTestId('app-home-browse-sessions').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await ensureSessionRow(page);
    await page.locator('[data-testid^="session-actions-"]').first().click();
    await page.locator('[data-testid^="session-actions-settings-"]').first().click();

    const settings = page.getByTestId('app-attach-settings-page');
    await expect(settings).toBeVisible();
    await expect(settings).toContainText('Attach settings');
    const save = page.getByTestId('app-attach-settings-submit');
    await expect(save).toBeEnabled({ timeout: 20_000 });
    await save.click();

    await expect(settings).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('app-attach-sheet')).toHaveCount(0);
    await expect(page.getByTestId('terminal-surface')).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/terminal\//);
  });
});
