const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

// Real Browser verifier: not a marker-only dependency declaration.
// Reuses the exact Case-managed Server/Agent/Web, checking the actual shell.
const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
test('1498 Scenario Case reaches the exact-SHA authenticated live shell', async ({ page }) => {
  expect(runtime.target_sha).toBe(process.env.NESSION_ACCEPTANCE_TARGET_SHA);
  expect(runtime.profile).toBe('full-stack-local');
  const serverURL = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverURL));
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('body')).not.toContainText('Connection failed');
});
