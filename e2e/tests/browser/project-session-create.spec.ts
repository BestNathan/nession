import { expect, test } from '@playwright/test';
import { expectSelectAnchored } from '../../helpers/selectAnchor';
import { waitForShell } from '../../helpers/shell';
import { E2E_RUN_DIR, E2E_SERVER_URL } from '../../runtime';

// Real-stack creation and the fixture's offline branch. Browser execution is
// CI-only by the repository's E2E policy.
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Project Existing-location Session creation', () => {
  test('creates a Session from the declared Existing Location', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    test.setTimeout(90_000);
    await page.goto(
      '/?token=e2e-test-token&server_url=' +
        encodeURIComponent(E2E_SERVER_URL),
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
    await projectDialog.locator('#project-create-location-path-0').fill(E2E_RUN_DIR);
    await projectDialog.getByTestId('project-create-submit').click();

    await expect(page.getByTestId('project-detail-title')).toHaveText(projectName);
    await page.getByTestId('project-detail-create-session').click();

    const sessionDialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
    await expect(sessionDialog).toBeVisible();
    // #3649: a Project create defaults to inheriting the declaration. This
    // Project declares no ENV defaults, so the effective preview is explicitly
    // empty rather than silently absent.
    await expect(
      sessionDialog.getByTestId('env-mode-inherit').getByRole('radio'),
    ).toBeChecked();
    await expect(sessionDialog.getByTestId('env-effective-origin')).toHaveText(
      'From Project defaults',
    );
    await expect(sessionDialog.getByTestId('env-effective-empty')).toBeVisible();
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
      // issue 3246: the content-sized list must grow from the trigger's start
      // edge, not drift with the selected item. At 390 the list is wider than
      // the trigger and Base UI shifts it inside the viewport; that legal
      // collision shift is asserted by the helper instead of forced to zero.
      const anchor = await expectSelectAnchored(page, trigger, {
        requireNoCollision: viewport.width >= 1024,
      });
      const popupBox = anchor.popup;
      expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(viewport.width + 2);
      const openTriggerBox = anchor.trigger;
      // The #3199 regression follows the approved resource-choice width contract:
      // resource choices may grow wider than the narrow anchor to
      // reveal metadata/long paths. They must still contain the anchor width
      // and fit inside the viewport; exact equality is the old action-list
      // contract, not the current rich-choice contract.
      expect(popupBox.width).toBeGreaterThanOrEqual(openTriggerBox.width - 1);
      expect(popupBox.x).toBeGreaterThanOrEqual(-0.5);
      for (const option of await options.all()) {
        const optionBox = await option.boundingBox();
        expect(optionBox).not.toBeNull();
        expect(optionBox!.width).toBeLessThanOrEqual(popupBox.width + 0.5);
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
      // Keyboard opening uses the same anchored geometry as a pointer open.
      const keyboardAnchor = await expectSelectAnchored(page, trigger, {
        requireNoCollision: viewport.width >= 1024,
      });
      expect(Math.abs(keyboardAnchor.gap - anchor.gap)).toBeLessThanOrEqual(1);
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
      // The selected option index does not move the popup's anchor.
      await trigger.click();
      const reopened = await expectSelectAnchored(page, trigger, {
        requireNoCollision: viewport.width >= 1024,
      });
      expect(Math.abs(reopened.popup.x - anchor.popup.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(reopened.popup.width - anchor.popup.width)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('option')).toHaveCount(0);
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
    // Both the form guidance and the location empty state use this phrase.
    // Assert the precise actionable empty state rather than an ambiguous match.
    await expect(dialog.getByText(
      'No Existing Location. Add an Agent directory in Project settings.',
      { exact: true },
    )).toBeVisible();
    await expect(dialog.getByTestId('project-location-trigger')).toHaveCount(0);
    await expect(dialog.getByTestId('create-session-submit')).toBeDisabled();
  });

  // #3649 SC-01 — the declaration is editable in Project settings, ordered,
  // and persisted through the Project update unit. The canonical fixture has
  // one Server ENV; removing and re-adding exercises both directions.
  test('Project settings edits the ordered default ENV references', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto('/#/fixture?projects=canonical');
    await page.getByTestId('project-item-row').first().click();
    await page.getByTestId('project-detail-settings').click();

    const dialog = page.getByTestId('project-settings-dialog');
    await expect(dialog).toBeVisible();
    const staged = dialog.getByTestId('env-selected-server::staging.env');
    await expect(staged).toContainText('staging.env');

    await dialog.getByTestId('env-selected-remove-server::staging.env').click();
    await expect(dialog.getByTestId('env-selected-server::staging.env')).toHaveCount(0);
    // The picker still offers the file; add it back as the sole ordered ref.
    await dialog.getByText('staging.env').click();
    await expect(dialog.getByTestId('env-selected-server::staging.env')).toContainText(
      'staging.env',
    );

    await dialog.getByTestId('project-settings-submit').click();
    await expect(page.getByTestId('project-settings-dialog')).not.toBeVisible();
    await expect(page.getByTestId('project-env-defaults')).toContainText('staging.env');
  });

  // #3649 SC-01/SC-02 — a missing reference is visible in the declaration and
  // in the create preview, and create refuses instead of falling back.
  test('a missing inherited ENV reference fails visibly', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto('/#/fixture?projects=missing-env');
    await page.getByTestId('project-item-row').first().click();
    await expect(page.getByTestId('project-env-default-missing-1')).toHaveText('(missing)');

    await page.getByTestId('project-detail-settings').click();
    const settings = page.getByTestId('project-settings-dialog');
    await expect(settings.getByTestId('project-settings-env-defaults-missing')).toContainText(
      'missing.env is not in the ENV Library',
    );
    await page.keyboard.press('Escape');
    await expect(settings).not.toBeVisible();

    await page.getByTestId('project-detail-create-session').click();
    const dialog = page.getByTestId('create-session-dialog');
    await dialog.locator('#name').fill('missing-default');
    await expect(dialog.getByTestId('env-effective-missing-1')).toBeVisible();
    await dialog.getByTestId('create-session-submit').click();
    await expect(dialog.getByTestId('create-session-error')).toContainText(
      'Cannot create Session: missing.env unavailable',
    );
  });

  // #3649 SC-02 — the three choices and their effective previews on Web. The
  // custom order is the picker's selection order; switching modes never mutates
  // the Project declaration.
  test('create Session distinguishes inherit, custom and no environment', async ({ page }) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto('/#/fixture?projects=canonical');
    await page.getByTestId('project-item-row').first().click();
    await page.getByTestId('project-detail-create-session').click();

    const dialog = page.getByTestId('create-session-dialog');
    await expect(dialog.getByTestId('env-mode-inherit').getByRole('radio')).toBeChecked();
    await expect(dialog.getByTestId('env-effective-origin')).toHaveText(
      'From Project defaults',
    );
    await expect(dialog.getByTestId('env-effective-list')).toContainText('staging.env');

    await dialog.getByTestId('env-mode-custom').click();
    await expect(dialog.getByTestId('env-effective-origin')).toHaveText(
      'Explicit replacement',
    );
    await expect(dialog.getByTestId('env-effective-empty')).toBeVisible();
    await dialog.getByText('prod.env').click();
    await expect(dialog.getByTestId('env-effective-item-0')).toContainText('prod.env');
    await dialog.getByText('local.env').click();
    await expect(dialog.getByTestId('env-effective-item-1')).toContainText('local.env');
    // Reordering is the declaration order the Session will materialize.
    await dialog.getByTestId('env-selected-up-agent:devbox-01:local.env').click();
    await expect(dialog.getByTestId('env-effective-item-0')).toContainText('local.env');
    await expect(dialog.getByTestId('env-effective-item-1')).toContainText('prod.env');

    await dialog.getByTestId('env-mode-none').click();
    await expect(dialog.getByTestId('env-effective-origin')).toHaveText('Explicit empty');
    await expect(dialog.getByTestId('env-effective-empty')).toBeVisible();

    await dialog.getByTestId('env-mode-inherit').click();
    await expect(dialog.getByTestId('env-effective-origin')).toHaveText(
      'From Project defaults',
    );
    await expect(dialog.getByTestId('env-effective-list')).toContainText('staging.env');
  });

  // #3649 SC-02 — App keeps one current-depth header/Back at 390 and 375 and
  // the mode choices stay touch-sized inside the viewport.
  for (const width of [390, 375]) {
    test(`App create Session environment modes stay usable at ${width}`, async ({ page }) => {
      test.skip(!process.env.CI, 'local only — runs in CI workflow only');
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/#/fixture/app?projects=canonical');
      await page.getByTestId('app-header-sessions').first().click();
      await page.getByTestId('project-item-row').first().click();
      const detail = page.getByTestId('app-project-detail');
      await expect(detail).toBeVisible();
      await expect(detail.getByTestId('app-page-header')).toHaveCount(1);

      await page.getByTestId('project-detail-create-session').click();
      const formPage = page.getByTestId('app-create-session-page');
      await expect(formPage).toBeVisible();
      await expect(formPage.getByTestId('app-page-header')).toHaveCount(1);
      await expect(page.getByTestId('app-session-env')).toContainText(
        'Use Project defaults',
      );
      await expect(page.getByTestId('app-session-env')).toContainText('staging.env');

      await page.getByTestId('app-session-env').click();
      const envPage = page.getByTestId('app-create-env-page');
      await expect(envPage).toBeVisible();
      await expect(envPage.getByTestId('app-page-header')).toHaveCount(1);
      await expect(
        page.getByTestId('app-env-mode-inherit').getByRole('radio'),
      ).toBeChecked();
      await expect(page.getByTestId('app-env-effective-preview')).toContainText(
        'From Project defaults',
      );
      await expect(page.getByTestId('app-env-effective-preview')).toContainText('staging.env');

      for (const id of ['app-env-mode-inherit', 'app-env-mode-custom', 'app-env-mode-none']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(-0.5);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
      }

      await page.getByTestId('app-env-mode-none').click();
      await expect(page.getByTestId('app-env-effective-preview')).toContainText(
        'Explicit empty',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
    });
  }
});
