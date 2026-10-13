'use strict';
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));

test('SC-06: canonical Acceptance browser reaches the real shell at the pinned SHA', async ({ page }) => {
  expect(runtime.target_sha).toBe(process.env.NESSION_ACCEPTANCE_TARGET_SHA);
  const serverUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl));
  await expect(page.locator('[data-testid="shell"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Connection failed');
});
