const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

const runtime = JSON.parse(
  fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'),
);

test('exact-SHA browser Case reaches the authenticated real shell', async ({ page }) => {
  const serverUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl));

  const shell = page.locator('[data-testid="shell"]');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('body')).not.toContainText('Connection failed');
});
