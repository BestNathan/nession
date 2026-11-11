import { expect, test } from '@playwright/test';
import { expectSelectAnchored } from '../../helpers/selectAnchor';

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

  test('Create Project footer stays opaque and flush with many locations', async ({ page }) => {
    await page.goto('/#/fixture?projects=canonical');
    await page.getByTestId('project-create').click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Create Project' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 8; i += 1) {
      await dialog.getByTestId('project-location-add').click();
    }
    expect(
      await dialog.evaluate((element) => element.scrollHeight > element.clientHeight),
      'the dialog is scrolling',
    ).toBe(true);

    const footer = dialog.locator('[data-slot="dialog-footer"]');
    await expect(footer).toHaveAttribute('data-sticky', 'true');
    const alpha = await footer.evaluate((element) => {
      const color = getComputedStyle(element).backgroundColor;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2d canvas is unavailable');
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] / 255;
    });
    expect(alpha, 'the sticky band is opaque').toBe(1);

    const dialogBox = await dialog.boundingBox();
    const footerBox = await footer.boundingBox();
    const submitBox = await dialog.getByTestId('project-create-submit').boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(
      Math.abs(footerBox!.y + footerBox!.height - (dialogBox!.y + dialogBox!.height)),
    ).toBeLessThanOrEqual(1);
    expect(submitBox!.y).toBeGreaterThanOrEqual(footerBox!.y - 0.5);
    expect(submitBox!.y + submitBox!.height).toBeLessThanOrEqual(
      footerBox!.y + footerBox!.height + 0.5,
    );

    // issue 3246: a Select opened in the scrolled dialog keeps its trigger
    // geometry even though its popup host lives inside the translated dialog
    // rather than on the body.
    const agent = dialog.locator('#project-create-location-agent-0');
    await agent.click();
    const anchor = await expectSelectAnchored(page, agent);
    expect(anchor.side).toBe('bottom');
    expect(anchor.horizontalCollision).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(dialog).toBeVisible();
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
