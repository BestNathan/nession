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

  // #3089 SC-07 — the multi-line Existing Location Select. The trigger must
  // contain the selected Agent/path/status, and the anchored options must wrap
  // a long path inside their own width rather than clip it or widen the form.
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 900 },
    { width: 1024, height: 700 },
    { width: 390, height: 844, narrow: true },
  ]) {
    test(`Existing Location Select contains a long path at ${viewport.width}`, async ({ page }) => {
      test.skip(!process.env.CI, 'local only — runs in CI workflow only');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/#/fixture?experience=web&projects=long');
      // The narrow Web route opens the overlay drawer; the Project destination
      // opens behind it, so close the drawer before driving the detail.
      await expect(page.getByTestId('project-item-row').first()).toBeVisible();
      await page.getByTestId('project-item-row').first().click();
      if ('narrow' in viewport && viewport.narrow) {
        await page.getByTestId('sidebar-drawer-close').click();
      }
      await page.getByTestId('project-detail-create-session').click();

      const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
      const trigger = dialog.getByTestId('project-location-trigger');
      await expect(trigger).toHaveAttribute('data-size', 'content');

      const triggerBox = await trigger.boundingBox();
      expect(triggerBox).not.toBeNull();
      // The selected record is three lines; the control grows to contain it
      // instead of keeping the single-line 32px height.
      expect(triggerBox!.height).toBeGreaterThan(60);
      expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);
      const path = trigger.getByTestId('project-location-path');
      const pathBox = await path.boundingBox();
      expect(pathBox).not.toBeNull();
      expect(pathBox!.y).toBeGreaterThanOrEqual(triggerBox!.y - 0.5);
      expect(pathBox!.y + pathBox!.height).toBeLessThanOrEqual(
        triggerBox!.y + triggerBox!.height + 0.5,
      );
      expect(
        await path.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      // One scroll owner: the dialog, never the form.
      const form = dialog.locator('form');
      expect(
        await form.evaluate((element) => getComputedStyle(element).overflowY),
      ).toBe('visible');

      await trigger.click();
      const options = page.getByRole('option');
      await expect(options).toHaveCount(2);
      const popup = page.locator('[data-slot="select-content"]');
      const popupBox = await popup.boundingBox();
      expect(popupBox).not.toBeNull();
      expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);
      const openTriggerBox = await trigger.boundingBox();
      // #3164 superseded the anchor-width-only option list: a resource list is
      // never narrower than its trigger, but may grow up to the choice-width
      // role and the viewport clamp. Equality is no longer the contract.
      expect(popupBox!.width).toBeGreaterThanOrEqual(openTriggerBox!.width - 0.5);
      for (const option of await options.all()) {
        const optionBox = await option.boundingBox();
        expect(optionBox).not.toBeNull();
        expect(optionBox!.width).toBeLessThanOrEqual(popupBox!.width + 0.5);
        expect(
          await option.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(1);
        const optionPath = option.getByTestId('project-location-path');
        const optionPathBox = await optionPath.boundingBox();
        expect(optionPathBox).not.toBeNull();
        expect(optionPathBox!.x).toBeGreaterThanOrEqual(optionBox!.x - 0.5);
        expect(optionPathBox!.x + optionPathBox!.width).toBeLessThanOrEqual(
          optionBox!.x + optionBox!.width + 0.5,
        );
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(viewport.width + 1);

      // Escape closes only the Select; keyboard selection moves to the second
      // Existing Location and the content-sized trigger still contains its
      // longer path.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('option')).toHaveCount(0);
      await trigger.press('ArrowDown');
      const secondOption = page.getByRole('option').nth(1);
      await expect(secondOption).toBeVisible();
      await secondOption.focus();
      await page.keyboard.press('Enter');
      await expect(trigger).toContainText('devbox-01');
      await expect(trigger).toContainText('very-long-directory-name-for-geometry');

      // Pointer selection returns to the first location.
      await trigger.click();
      await page.getByRole('option').first().click();
      await expect(trigger).toContainText('macbook');
      const selectedBox = await trigger.boundingBox();
      expect(selectedBox).not.toBeNull();
      expect(selectedBox!.y + selectedBox!.height).toBeLessThanOrEqual(
        viewport.height + 0.5,
      );
      const selectedPath = trigger.getByTestId('project-location-path');
      expect(
        await selectedPath.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
    });
  }

  test('a Project with no Existing Location explains the empty state', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto('/#/fixture?projects=canonical');
    // The second canonical Project ("Ops notes") declares no locations.
    await page.getByTestId('project-item-row').nth(1).click();
    await page.getByTestId('project-detail-create-session').click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
    await expect(dialog.getByText(/No Existing Location/)).toBeVisible();
    await expect(dialog.getByTestId('project-location-trigger')).toHaveCount(0);
    await expect(dialog.getByTestId('create-session-submit')).toBeDisabled();
  });
});
