import { expect, test } from '@playwright/test';

// The fixture route needs no Server, but the repository's canonical E2E policy
// still runs browser specs only in CI.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Project management', () => {
  test('creates, renames and deletes a Project without touching Sessions', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical');
    await expect(page.getByTestId('projects-section')).toBeVisible();
    await expect(page.getByTestId('project-item-row')).toHaveCount(2);
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    // ── Create: a name is the only required field ──
    await page.getByTestId('project-create').click();
    const createDialog = page.getByRole('dialog').filter({ hasText: 'Create Project' });
    await expect(createDialog).toBeVisible();
    await createDialog.locator('#project-create-name').fill('Managed Notes');
    await createDialog.getByTestId('project-create-submit').click();

    await expect(page.getByTestId('project-detail-title')).toHaveText('Managed Notes');
    await expect(page.getByTestId('project-item-row')).toHaveCount(3);
    const newRow = page.getByTestId('project-item-row').filter({ hasText: 'Managed Notes' });
    const projectId = await newRow.getAttribute('data-project-id');
    expect(projectId).toBeTruthy();

    // ── Rename through the row menu ──
    await page.getByTestId(`project-actions-${projectId}`).click();
    await page.getByTestId(`project-actions-rename-${projectId}`).click();
    const renameDialog = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
    await renameDialog.locator('#project-rename-name').fill('Renamed Notes');
    await renameDialog.getByTestId('project-rename-submit').click();
    await expect(page.getByTestId('project-item-row').filter({ hasText: 'Renamed Notes' }))
      .toHaveCount(1);
    await expect(page.getByTestId('project-detail-title')).toHaveText('Renamed Notes');

    // ── Delete cancels explicitly, then confirms without cascading ──
    await page.getByTestId(`project-actions-${projectId}`).click();
    await page.getByTestId(`project-actions-delete-${projectId}`).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Renamed Notes');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('project-item-row')).toHaveCount(3);

    await page.getByTestId(`project-actions-${projectId}`).click();
    await page.getByTestId(`project-actions-delete-${projectId}`).click();
    await page.getByTestId('project-delete-confirm').click();
    await expect(page.getByTestId('project-item-row')).toHaveCount(2);
    await expect(page.getByTestId('project-detail')).toHaveCount(0);
    // The existing Session list is untouched by a Project deletion.
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);
  });

  test('Projects remain reachable with zero Sessions', async ({ page }) => {
    await page.goto('/#/fixture?sessions=none&selection=none&projects=canonical');
    await expect(page.getByTestId('session-item-row')).toHaveCount(0);
    await expect(page.getByTestId('projects-section')).toBeVisible();
    await expect(page.getByTestId('project-item-row')).toHaveCount(2);

    await page.getByTestId('project-item-row').first().click();
    await expect(page.getByTestId('project-detail')).toBeVisible();
    await expect(page.getByTestId('project-detail-title')).toBeVisible();
  });
});
