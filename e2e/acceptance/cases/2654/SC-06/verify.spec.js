'use strict';
// #2654 SC-06: the published interactive mock demonstrates the Session-first
// Web flow and the narrow App flow. This drives the live Pages preview at the
// two canonical viewports; it does not treat the mock as production evidence.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const PREVIEW = 'https://bestnathan.github.io/nession/prototypes/environment-session-2654/index.html';

test('SC-06: the published mock demonstrates the Session-first Web and mobile flows', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-06');

  // Web 1440: default Session overview, ordered draft, Apply → pending, the
  // simulated prompt, then a profile Save that only Reapply publishes.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PREVIEW);
  await expect(page).toHaveTitle(/Session Environment prototype #2654/);
  await expect(page.getByRole('heading', { name: 'Session Environment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage binding' })).toBeVisible();

  await page.getByRole('button', { name: 'Manage binding' }).click();
  await page.getByRole('checkbox', { name: /ai-tools\.env/ }).click();
  await expect(page.getByText(/3 profiles/).first()).toBeVisible();
  await expect(page.getByText(/effective variables/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByText('Waiting for next shell prompt').first()).toBeVisible();
  await expect(page.getByText(/Existing running processes did not change/)).toBeVisible();

  await page.getByRole('button', { name: /模拟 Bash 返回下次 Prompt/ }).click();
  await expect(page.getByText(/Current Session environment is applied/)).toBeVisible();

  await page.getByRole('button', { name: '查看' }).first().click();
  await page.getByRole('button', { name: 'Simulate profile edit' }).click();
  await expect(page.getByText(/Simulated Profile Save/)).toBeVisible();
  await page.getByRole('button', { name: /Current Session/ }).click();
  await expect(page.getByText('Reapply explicitly')).toBeVisible();
  await page.getByRole('button', { name: 'Reapply explicitly' }).click();
  await expect(page.getByText(/Explicit Reapply published a new snapshot revision/)).toBeVisible();

  // No Session: the mock invents no binding.
  await page.getByRole('button', { name: '无 Session 场景' }).click();
  await expect(page.getByRole('heading', { name: 'No active Session' })).toBeVisible();
  await expect(page.getByText(/No Session binding is invented/)).toBeVisible();
  await page.getByRole('button', { name: '恢复 Session' }).click();

  // App 390×844: root summary → pushed Session detail → one Back.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /dev-session/ })).toBeVisible();
  await page.getByRole('button', { name: /dev-session/ }).click();
  await expect(page.getByRole('heading', { name: 'Session Environment' })).toBeVisible();
  await expect(page.getByRole('button', { name: /返回 Environment/ })).toBeVisible();
  await page.getByRole('button', { name: /返回 Environment/ }).click();
  await expect(page.getByRole('button', { name: /dev-session/ })).toBeVisible();

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': live Pages mock at 1440x900 and 390x844 ran the Session-default ' +
      'overview, ordered add/apply -> pending, simulated prompt convergence, profile save -> explicit ' +
      'Reapply, no-Session state, and the narrow summary/back depth',
  });
});
