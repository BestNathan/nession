import { expect, test } from '@playwright/test';

// Fixture-only binding/capability spec; browser execution is CI-only by the
// repository's E2E policy.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const PROJECT_ONE = 'project-00000000-0000-4000-8000-000000000001';
const PROJECT_TWO = 'project-00000000-0000-4000-8000-000000000002';

declare global {
  interface Window {
    fixtureSessionProject?: {
      bindings: () => Record<string, string | null>;
      /** Commit another client's save before this editor writes (#4234). */
      simulateRemoteChange: (sessionId: string, projectId: string | null) => void;
      setRequests: () => {
        session_id: string;
        project_id: string | null;
        expected_revision?: number;
      }[];
    };
  }
}

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
    // First association of an unassociated Session echoes the read model's
    // `0` token (#4234), so the Server's CAS path is exercised, not the
    // optional-revision last-writer-wins compatibility.
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureSessionProject?.setRequests() ?? []),
      )
      .toEqual([
        {
          session_id: 'macbook:dotfiles',
          project_id: PROJECT_ONE,
          expected_revision: 0,
        },
      ]);
  });

  test('a stale membership editor conflicts, keeps its selection and retries on the fresh revision', async ({ page }) => {
    const sessionId = 'devbox-01:fix-terminal-reconnect';
    await page.goto('/#/fixture?projects=canonical&sessionProject=bound');
    await expect(page.getByTestId('session-project-chip')).toHaveText('Nession');

    // A opens the editor at revision 1 and picks Ops notes.
    await page.getByTestId(`session-actions-${sessionId}`).click();
    await page.getByTestId(`session-actions-project-${sessionId}`).click();
    await expect(page.getByTestId('session-project-dialog')).toBeVisible();
    await page.getByTestId('session-project-trigger').click();
    await page.getByRole('option', { name: 'Ops notes' }).click();

    // B commits a removal from its own valid observation before A saves.
    await page.evaluate(
      (id) => window.fixtureSessionProject?.simulateRemoteChange(id, null),
      sessionId,
    );

    await page.getByTestId('session-project-save').click();
    const conflict = page.locator(
      '[data-testid="session-project-error"][data-conflict="true"]',
    );
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('Another change was saved first');
    // A's intended selection survives, and B's committed removal is untouched.
    await expect(page.getByTestId('session-project-selected')).toHaveText('Ops notes');
    await expect
      .poll(() => page.evaluate(() => window.fixtureSessionProject?.bindings() ?? {}))
      .toMatchObject({ [sessionId]: null });

    // The conflict reply carried the current token, so an intentional retry
    // commits against the fresher state instead of replaying the stale one.
    await page.getByTestId('session-project-save').click();
    await expect(page.getByTestId('session-project-chip')).toHaveText('Ops notes');
    await expect
      .poll(() => page.evaluate(() => window.fixtureSessionProject?.setRequests() ?? []))
      .toEqual([
        {
          session_id: sessionId,
          project_id: PROJECT_TWO,
          expected_revision: 1,
        },
        {
          session_id: sessionId,
          project_id: PROJECT_TWO,
          expected_revision: 0,
        },
      ]);
    await expect
      .poll(() => page.evaluate(() => window.fixtureSessionProject?.bindings() ?? {}))
      .toMatchObject({ [sessionId]: PROJECT_TWO });
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
