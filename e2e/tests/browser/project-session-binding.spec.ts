import { expect, test } from '@playwright/test';

// Fixture-only binding/capability spec; browser execution is CI-only by the
// repository's E2E policy.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.describe('Session Project capability', () => {
  test.use({ viewport: { width: 1180, height: 900 } });

  test('shows the focused Session Project, Peek and Workspace, then returns to the Terminal', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical&sessionProject=bound');
    const selected = page.locator(
      '[data-session-row="devbox-01:fix-terminal-reconnect"][data-selected="true"]',
    );
    await expect(selected).toHaveCount(1);
    await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

    await page.getByTestId('session-project-chip').click();
    await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
    await expect(page.getByTestId('project-peek-name')).toHaveText('Nession');
    await expect(page.getByTestId('project-peek-manage')).toBeVisible();

    await page.getByTestId('capsule-capability-open-workspace').click();
    await expect(page.getByTestId('workspace-project-view')).toBeVisible();
    await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
    await expect(page.getByTestId('project-related-session')).toHaveCount(1);
    await expect(page.getByTestId('project-related-session')).toContainText('staging-deploy');
    await expect(selected).toHaveCount(1);

    await page.getByTestId('surface-action-open-terminal').click();
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();
    await expect(selected).toHaveCount(1);
  });

  test('recomputes from each focused Session and associates an unbound one explicitly', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical&sessionProject=bound-ab');
    await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

    await page
      .locator('[data-session-row="devbox-01:design-system"]')
      .getByRole('button')
      .first()
      .click();
    await expect(page.getByTestId('session-project-chip')).toHaveText('Ops notes');

    await page
      .locator('[data-session-row="macbook:dotfiles"]')
      .getByRole('button')
      .first()
      .click();
    await expect(page.getByTestId('session-project-chip')).toHaveCount(0);

    await page.getByTestId('session-actions-macbook:dotfiles').click();
    await page.getByTestId('session-actions-project-macbook:dotfiles').click();
    await expect(page.getByTestId('session-project-dialog')).toBeVisible();
    await page.getByTestId('session-project-trigger').click();
    await page.getByRole('option', { name: 'Nession' }).click();
    await page.getByTestId('session-project-save').click();
    await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureSessionProject?.setRequests() ?? []),
      )
      .toHaveLength(1);
  });

  test('fails unavailable safely for a deleted Project', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical&sessionProject=deleted');
    await expect(page.getByTestId('session-project-chip')).toHaveText('Project unavailable');
    await page.getByTestId('session-project-chip').click();
    await expect(page.getByTestId('session-project-dialog')).toBeVisible();
    await expect(page.getByTestId('session-project-selected')).toHaveText('Project unavailable');
  });
});

test.describe('Session Project capability (App)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('shows the Project Peek and Workspace with one header and returns to the Terminal', async ({ page }) => {
    await page.goto('/#/fixture/app?projects=canonical&sessionProject=bound');
    await page.getByTestId('app-header-sessions').click();
    await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
    await page
      .locator('[data-session-row="devbox-01:fix-terminal-reconnect"]')
      .getByRole('button')
      .first()
      .click();
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();
    await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

    await page.getByTestId('session-project-chip').click();
    await expect(page.getByTestId('project-peek-name')).toHaveText('Nession');
    await page.getByTestId('capsule-capability-open-workspace').click();
    await expect(page.getByTestId('workspace-project-view')).toBeVisible();
    await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
    await expect(page.getByTestId('app-page-header')).toHaveCount(1);
    await expect(page.getByTestId('project-related-session')).toHaveCount(1);

    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('fixture-terminal')).toBeVisible();
    await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');
  });
});
