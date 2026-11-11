'use strict';
// #3025 SC-07: zero Sessions still expose Projects on Web and App, the first
// Session can be started from the standalone detail, App Back returns to the
// empty Sessions layer, and opening/closing a Project never kills or resets a
// preexisting Terminal.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const TERMINAL_MARKER = 'git status --short';

async function terminalText(page) {
  return page.locator('[data-testid="fixture-terminal"] .xterm-rows').textContent();
}

test('SC-07: Web and App expose Projects with zero Sessions', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-07');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?sessions=none&selection=none&projects=canonical');
  await expect(page.getByTestId('session-item-row')).toHaveCount(0);
  await expect(page.getByTestId('projects-section')).toBeVisible();
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(page.getByTestId('project-detail-title')).toHaveText('Nession');
  // The first-Session entry from the empty work surface is available.
  await page.getByTestId('project-detail-create-session').click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Create Session in' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('create-session-submit')).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?sessions=none&projects=canonical');
  await page.getByTestId('app-header-sessions').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(page.getByTestId('session-item-row')).toHaveCount(0);
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('app-project-detail')).toBeVisible();
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await expect(page.getByTestId('session-item-row')).toHaveCount(0);
  await expect(page.getByTestId('project-item-row')).toHaveCount(2);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': with zero Session rows, Web 1440x900 kept both Projects ' +
      'selectable, opened the Nession detail and enabled Existing creation; App 390x844 ' +
      'kept both Projects after zero Session history, pushed the detail and returned through ' +
      'Back to the empty Sessions layer',
  });
});

test('SC-07: Project navigation preserves a preexisting Terminal and its selection', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-07');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?projects=canonical');
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain(TERMINAL_MARKER);
  const selected = page.locator('[data-testid="session-item-row"][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  const selectedSession = await selected.getAttribute('data-session-row');

  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('project-detail')).toBeVisible();
  await expect(selected).toHaveCount(1);
  expect(await selected.getAttribute('data-session-row')).toBe(selectedSession);

  await page.locator(`[data-testid="session-item-row"][data-session-row="${selectedSession}"]`)
    .getByRole('button').first().click();
  await expect(page.getByTestId('project-detail')).toHaveCount(0);
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain(TERMINAL_MARKER);
  await expect(selected).toHaveCount(1);
  expect(await selected.getAttribute('data-session-row')).toBe(selectedSession);

  // App keeps the Terminal mounted while the Project detail is pushed.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?projects=canonical');
  await page.getByTestId('app-header-sessions').click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain(TERMINAL_MARKER);
  await page.getByTestId('project-item-row').first().click();
  await expect(page.getByTestId('app-project-detail')).toBeVisible();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain(TERMINAL_MARKER);
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('fixture-terminal')).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain(TERMINAL_MARKER);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Web kept Session ' + selectedSession + ' selected while the ' +
      'Project detail replaced the main region; returning restored the Terminal with its ' +
      'git-status buffer; App kept the same Terminal mounted with the same buffer while the ' +
      'Project detail was pushed and after Back',
  });
});
