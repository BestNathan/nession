// #3137 SC-04: a real Chromium walkthrough of the three revised, published
// prototypes — Project detail/settings, Sandbox outside/inside, and the Project
// operation surface. The runtime verifier proves the exact pinned source and
// Pages readback; this file proves the mock journey a reviewer actually sees.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { verifiedRuntime } from '../../../shared/foreground-resume-browser.cjs';

const BASE = 'https://bestnathan.github.io/nession/prototypes';
const PROJECT_URL = BASE + '/project-session-3025/index.html';
const SANDBOX_URL = BASE + '/sandbox-capability-3124/index.html';
const OPERATION_URL = BASE + '/session-operation-surfaces-3089/index.html';

async function style(locator: Locator): Promise<Record<string, string>> {
  return locator.evaluate((element) => {
    const value = getComputedStyle(element);
    return {
      fontSize: value.fontSize,
      fontWeight: value.fontWeight,
      lineHeight: value.lineHeight,
    };
  });
}

test('SC-04: the published prototypes show the revised detail/form/operation grammar', async ({
  page,
}) => {
  test.setTimeout(110_000);
  verifiedRuntime('SC-04');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // ── Project: resource detail, then named configuration sections ──
  await page.goto(PROJECT_URL);
  const project = page.locator('.project-product');
  await expect(project).toBeVisible();
  await project.locator('[data-action="project"]').first().click();
  await expect(project.locator('.detail-section').first()).toBeVisible();
  expect(await project.locator('.detail-section').count()).toBeGreaterThanOrEqual(4);
  expect(await project.locator('.detail-fact').count()).toBeGreaterThan(0);

  const projectTitle = await style(project.locator('h1').first());
  expect(projectTitle.fontSize).toBe('16px');
  expect(projectTitle.fontWeight).toBe('600');
  const projectSection = await style(project.locator('.detail-section h2').first());
  expect(projectSection.fontSize).toBe('12.5px');
  expect(projectSection.fontWeight).toBe('500');
  const projectFact = project.locator('.detail-fact').first();
  const factChrome = await projectFact.evaluate((element) => {
    const value = getComputedStyle(element);
    return [value.borderTopWidth, value.borderBottomWidth, value.backgroundColor];
  });
  expect(factChrome[0]).toBe('0px');
  expect(factChrome[1]).toBe('0px');
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(factChrome[2]);

  await project.locator('[data-action="settings"]').first().click();
  await expect(project.locator('.form-surface').first()).toBeVisible();
  expect(await project.locator('.form-section').count()).toBeGreaterThanOrEqual(3);
  const projectLabel = await style(project.locator('.form-section .field label').first());
  expect(projectLabel.fontSize).toBe('13px');
  expect(projectLabel.fontWeight).toBe('500');
  const projectInput = project.locator('#f-project');
  expect((await projectInput.boundingBox())?.height).toBe(32);
  const cancel = project.locator('.form-actions [data-action="project"]').first();
  const save = project.locator('[data-action="save-settings"]').first();
  expect((await cancel.boundingBox())!.x).toBeLessThan((await save.boundingBox())!.x);

  // App 390 keeps the same recipe at the touch band and stacked sections.
  await page.locator('[data-np-size="390"]').click();
  await expect(page.locator('[data-np-current-size]')).toContainText('390');
  expect((await projectInput.boundingBox())?.height).toBe(44);
  expect(await project.locator('.form-grid').first().evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
  )).toBe(1);

  // ── Sandbox: Outside form, one action line, explicit Enter, Inside facts ──
  await page.goto(SANDBOX_URL);
  const sandbox = page.locator('.nession-ui');
  await expect(sandbox).toBeVisible();
  await sandbox.locator('[data-action="workspace"]').first().click();
  await expect(sandbox.getByTestId('sandbox-tab-filesystem')).toBeVisible();
  const sandboxTitle = await style(sandbox.locator('.workspace h2').first());
  expect(sandboxTitle.fontSize).toBe('16px');
  expect(sandboxTitle.fontWeight).toBe('600');

  await sandbox.getByTestId('sandbox-tab-filesystem').click();
  const sandboxLabel = await style(sandbox.locator('.field label').first());
  expect(sandboxLabel.fontSize).toBe('13px');
  expect(sandboxLabel.fontWeight).toBe('500');
  expect((await sandbox.locator('.field input').first().boundingBox())?.height).toBe(32);
  const sandboxSection = await style(
    sandbox.locator('[data-testid="sandbox-tab-panel"] h3').first(),
  );
  expect(sandboxSection.fontSize).toBe('12.5px');
  expect(sandboxSection.fontWeight).toBe('500');

  await sandbox.getByTestId('sandbox-tab-overview').click();
  const validate = sandbox.locator('[data-action="validate"]').first();
  const enter = sandbox.locator('[data-action="enter"]').first();
  expect((await validate.boundingBox())!.x).toBeLessThan((await enter.boundingBox())!.x);
  await validate.click();
  await expect(enter).toBeEnabled();
  await enter.click();
  await expect(sandbox.locator('[data-action="confirm-enter"]')).toBeVisible();
  await sandbox.locator('[data-action="confirm-enter"]').click();
  await expect(sandbox.locator('[data-action="return-native"]')).toBeVisible();

  // ── Operation: one title, named sections, secondary before primary ──
  await page.goto(OPERATION_URL);
  const operation = page.locator('.nession-product');
  await expect(operation).toBeVisible();
  await operation.locator('[data-act="show-project"]').first().click();
  await operation.locator('[data-act="project-settings"]').first().click();
  const dialog = operation.locator('.web-dialog, .app-operation').first();
  await expect(dialog).toBeVisible();
  const dialogTitle = await style(dialog.locator('.dialog-head h2, .app-header .app-title').first());
  expect(dialogTitle.fontSize).toBe('16px');
  expect(dialogTitle.fontWeight).toBe('600');
  expect(await dialog.locator('.form-section').count()).toBeGreaterThanOrEqual(3);
  const operationLabel = await style(dialog.locator('.form-section .field .label').first());
  expect(operationLabel.fontSize).toBe('13px');
  expect(operationLabel.fontWeight).toBe('500');
  expect((await dialog.locator('.form-section .field input').first().boundingBox())?.height).toBe(32);
  const dialogCancel = dialog.locator('.dialog-footer .btn').first();
  const dialogSave = dialog.locator('.dialog-footer .btn.primary').first();
  expect((await dialogCancel.boundingBox())!.x).toBeLessThan((await dialogSave.boundingBox())!.x);

  await page.locator('[data-np-size="390"]').click();
  await expect(page.locator('[data-np-current-size]')).toContainText('390');
  // Changing Experience returns the mock to its App Sessions root; reopen the
  // same Project settings as the App operation page.
  await operation.locator('[data-act="show-project"]').first().click();
  await operation.locator('[data-act="project-settings"]').first().click();
  const appDialog = operation.locator('.app-operation').first();
  await expect(appDialog).toBeVisible();
  expect((await appDialog.locator('.form-section .field input').first().boundingBox())?.height).toBe(44);

  expect(pageErrors, 'prototype pages must not throw').toEqual([]);
});
