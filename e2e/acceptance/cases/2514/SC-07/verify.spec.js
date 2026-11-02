'use strict';
// #2514 SC-07 (browser half): the public Pages artifact is the revised mock,
// and its representative states/interactions work in a real browser:
// default-closed Agent details opening into three groups, default-closed
// Process details opening into identity/discovery evidence while command and
// resources stay visible, the explicit no-current-Session state, and the
// 390px process-list → detail → Back path.
const { test, expect } = require('@playwright/test');

const PROTOTYPE_URL =
  'https://bestnathan.github.io/nession/prototypes/agent-process-discovery-2514/index.html';
const MANIFEST_URL = 'https://bestnathan.github.io/nession/prototypes/manifest.json';
const SLUG = 'agent-process-discovery-2514';

test.use({ viewport: { width: 1440, height: 900 } });

test('SC-07: the published revised prototype is interactive', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);

  const manifestResponse = await request.get(MANIFEST_URL, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest.source).toMatchObject({ branch: 'prototype' });
  expect(manifest.entries.some((entry) => entry.slug === SLUG)).toBe(true);
  const revision = manifest.source.sha;

  const response = await page.goto(PROTOTYPE_URL + '?revision=' + revision, {
    waitUntil: 'load',
    timeout: 30_000,
  });
  expect(response.status()).toBe(200);
  await expect(page).toHaveTitle(/Agent Workspace/);

  // Agent details is default-closed, keyboard-operable, and grouped.
  const agentDetails = page.locator('details#agent-details');
  await expect(agentDetails).toHaveJSProperty('open', false);
  await agentDetails.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(agentDetails).toHaveJSProperty('open', true);
  for (const group of [
    'Identity & connection',
    'Runtime environment',
    'Capability & discovery',
  ]) {
    await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
  }

  // Command and resources are immediately visible; Process details is
  // default-closed and expands into the two evidence groups.
  await expect(page.getByText('Executed command', { exact: true })).toBeVisible();
  await expect(page.getByText('Resources', { exact: true })).toBeVisible();
  const processDetails = page.locator('#inspector details.evidence');
  await expect(processDetails).toHaveJSProperty('open', false);
  await processDetails.locator('summary').click();
  await expect(processDetails).toHaveJSProperty('open', true);
  await expect(page.getByRole('heading', { name: 'Process identity', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Discovery evidence', exact: true })).toBeVisible();

  // The no-current-Session state is explicit and never selects another mock
  // Session.
  await page.locator('#scenario').selectOption('no-session');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty')).toContainText('当前没有可检查的 Session');
  await expect(page.locator('#empty')).toContainText('不会自动选择');
  await expect(page.locator('#split')).toBeHidden();

  // The mock's other representative states remain reachable.
  await page.locator('#scenario').selectOption('linux');
  await expect(page.locator('#tree')).toBeVisible();

  // 390px: process list → detail → Back returns to the list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#tree')).toBeVisible();
  await page.locator('#tree').getByRole('button', { name: /claude/ }).click();
  const back = page.locator('#back');
  await expect(back).toBeVisible();
  await expect(page.getByText('Executed command', { exact: true })).toBeVisible();
  await back.click();
  await expect(page.locator('#tree')).toBeVisible();
  await expect(page.locator('#back')).toBeHidden();

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'live Pages revision ' + revision +
      ': default-closed Agent details opened into three groups; Process details opened into identity/discovery ' +
      'while command/resources stayed visible; no-current-Session showed the explicit empty state; at 390px ' +
      'a process opened its detail and Back returned to the process list',
  });
});
