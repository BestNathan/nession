import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';

const token = execSync(
  'kubectl get secret nession-secret-staging -n nession -o jsonpath="{.data.auth-token}" | base64 -d',
  { encoding: 'utf8' },
).trim();

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto('http://localhost:13000/?session_first=1');
await page.evaluate(() => localStorage.clear());

await page.getByLabel('Server URL').fill('ws://staging.nession.nhome.local/ws');
await page.getByLabel('Auth Token').fill(token);
await page.locator('button', { hasText: /^Connect$/ }).click();

await page.waitForTimeout(8000);

const shell = await page.locator('[data-testid="session-first-shell"]').count();
const reconnecting = await page.getByText('Reconnecting…').count();
console.log(JSON.stringify({ shell, reconnecting }));

await page.screenshot({
  path: path.resolve('.playwright-mcp/screenshots/staging-manual-login.png'),
  fullPage: true,
});
await browser.close();
