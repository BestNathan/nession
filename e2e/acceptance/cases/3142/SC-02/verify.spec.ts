// #3142 SC-02: production Web overlay roles. Attach/Create Session/Project/
// Delete and an anchored Select/Menu/Popover resolve their size from the shared
// semantic roles, keep one scroll owner, keep the action band opaque/flush and
// never introduce horizontal page overflow at 1440/1180/1024 and constrained
// height.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { freezeFixtureClock, waitForFixtureTerminal } from '../../../../helpers/fixtureVisual';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

async function tokenPx(page: Page, variable: string): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;max-width:var(${name})`;
    document.body.append(probe);
    const value = parseFloat(getComputedStyle(probe).maxWidth);
    probe.remove();
    return value;
  }, variable);
}

async function backgroundAlpha(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
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
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function settledBox(page: Page, locator: Locator) {
  await expect.poll(async () => {
    const first = await locator.boundingBox();
    await page.waitForTimeout(60);
    const second = await locator.boundingBox();
    return first && second && Math.abs(first.width - second.width) < 0.5 &&
      Math.abs(first.height - second.height) < 0.5
      ? Math.round(second.width)
      : -1;
  }).toBeGreaterThan(0);
  const box = await locator.boundingBox();
  return box!;
}

async function expectRole(
  page: Page,
  dialog: Locator,
  size: 'compact' | 'standard' | 'wide',
): Promise<void> {
  await expect(dialog).toHaveAttribute('data-size', size);
  const expected = await tokenPx(page, `--nession-overlay-${size}-max-width`);
  const box = await settledBox(page, dialog);
  expect(box.width).toBeLessThanOrEqual(expected + 1);
  expect(box.width).toBeGreaterThan(expected - 24);
  const maxWidth = await dialog.evaluate((element) => parseFloat(getComputedStyle(element).maxWidth));
  expect(maxWidth).toBe(expected);
}

test('SC-02: Web dialogs and the alert confirmation use the semantic roles', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  await freezeFixtureClock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Attach settings: wide. The fixture's operation route opens the existing
  // AttachDialog directly (the row action opens it only on a live stack).
  await page.goto('/#/fixture?operation=attach-settings&projects=canonical');
  await waitForFixtureTerminal(page);
  const attach = page.getByTestId('attach-dialog');
  await expect(attach).toBeVisible();
  await expectRole(page, attach, 'wide');
  await expect(attach.locator('[data-slot="dialog-footer"]')).toBeVisible();
  await noHorizontalOverflow(page);
  await attach.getByRole('button', { name: 'Cancel' }).click();
  await expect(attach).toHaveCount(0);
  await page.goto('/#/fixture?projects=canonical');
  await page.reload();
  await waitForFixtureTerminal(page);

  // Create Session: standard (Project mode keeps the Existing Location Select).
  await page.getByTestId('project-item-row').first().click();
  await page.getByTestId('project-detail-create-session').click();
  const create = page.getByTestId('create-session-dialog');
  await expect(create).toBeVisible();
  await expectRole(page, create, 'standard');
  await noHorizontalOverflow(page);
  await create.getByRole('button', { name: 'Cancel' }).click();

  // New Project: wide.
  await page.getByTestId('project-create').click();
  const project = page.getByTestId('create-project-dialog');
  await expect(project).toBeVisible();
  await expectRole(page, project, 'wide');
  await noHorizontalOverflow(page);
  await project.getByRole('button', { name: 'Cancel' }).click();

  // Rename: compact.
  const projectId = await page.getByTestId('project-item-row').first().getAttribute('data-project-id');
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-rename-${projectId}`).click();
  const rename = page.getByRole('dialog').filter({ hasText: 'Rename Project' });
  await expect(rename).toBeVisible();
  await expectRole(page, rename, 'compact');
  await rename.getByRole('button', { name: 'Cancel' }).click();

  // Delete: the alert shares the compact role and the one scrim.
  await page.getByTestId(`project-actions-${projectId}`).click();
  await page.getByTestId(`project-actions-delete-${projectId}`).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert).toBeVisible();
  expect(await alert.evaluate((element) => parseFloat(getComputedStyle(element).maxWidth)))
    .toBe(await tokenPx(page, '--nession-overlay-compact-max-width'));
  const scrimMatched = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;background-color:var(--nession-overlay-scrim)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [...document.querySelectorAll('div')].some((element) => {
      const style = getComputedStyle(element);
      return style.position === 'fixed' && style.inset === '0px' &&
        style.backgroundColor === expected;
    });
  });
  expect(scrimMatched, 'the alert uses the shared scrim').toBe(true);
  await page.keyboard.press('Escape');
  await expect(alert).toHaveCount(0);
  expect(await page.getByTestId('project-item-row').count()).toBe(2);
  await noHorizontalOverflow(page);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Attach wide, Create Session standard, New Project wide, ' +
      'Rename compact and the Delete alert shared the compact role and one scrim; no ' +
      'horizontal overflow at 1440',
  });
});

test('SC-02: anchored layers stay above their dialog and one body scroll keeps the footer flush', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');
  const observed: string[] = [];

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1180, height: 700 },
    { width: 1024, height: 700 },
  ]) {
    await freezeFixtureClock(page);
    await page.setViewportSize(viewport);
    await page.goto('/#/fixture?projects=canonical');
    await waitForFixtureTerminal(page);
    await page.getByTestId('project-create').click();
    const dialog = page.getByTestId('create-project-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('project-location-add').click();

    const trigger = dialog.locator('#project-create-location-agent-0');
    await trigger.click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();
    const optionHeight = (await settledBox(page, options.first())).height;
    expect(optionHeight).toBe(await tokenPx(page, '--nession-control-sm'));
    const layers = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="select-content"]');
      const content = document.querySelector('[data-testid="create-project-dialog"]');
      return {
        popup: popup ? Number(getComputedStyle(popup).zIndex) : -1,
        dialog: content ? Number(getComputedStyle(content).zIndex) : -1,
      };
    });
    expect(layers.popup).toBeGreaterThan(layers.dialog);
    await options.nth(1).click();
    await expect(trigger).not.toHaveAttribute('data-popup-open', '');
    await expect(dialog).toBeVisible();

    // Escape closes the anchored layer first, returns focus to the trigger and
    // leaves the dialog open.
    await trigger.click();
    await expect(options.first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      'project-create-location-agent-0',
    );

    // Enough locations force the body to be the one vertical scroll owner; the
    // footer stays opaque and flush with the dialog edge.
    for (let index = 0; index < 8; index += 1) {
      await dialog.getByTestId('project-location-add').click();
    }
    const body = dialog.locator('[data-slot="dialog-body"]');
    await expect.poll(async () =>
      body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(
      await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
      'the dialog surface does not own the scroll',
    ).toBe(true);
    expect(
      await dialog.locator('form').evaluate((element) => getComputedStyle(element).overflowY),
    ).toBe('visible');
    const dialogBox = await settledBox(page, dialog);
    const footer = dialog.locator('[data-slot="dialog-footer"]');
    const footerBox = await settledBox(page, footer);
    expect(Math.abs(footerBox.y + footerBox.height - (dialogBox.y + dialogBox.height)))
      .toBeLessThanOrEqual(1);
    expect(await backgroundAlpha(footer)).toBe(1);
    await noHorizontalOverflow(page);
    observed.push(`${viewport.width}x${viewport.height}: row ${optionHeight}px, popup z ${layers.popup} > dialog ${layers.dialog}, footer flush/opaque`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join(' | '),
  });
});
