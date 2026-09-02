import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.playwright-mcp/screenshots');
mkdirSync(OUT, { recursive: true });

const token = execSync(
  'kubectl get secret nession-secret-staging -n nession -o jsonpath="{.data.auth-token}" | base64 -d',
  { encoding: 'utf8' },
).trim();

const STAGING_WS = 'ws://staging.nession.nhome.local/ws';

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto('http://localhost:13000/');
await page.evaluate(() => localStorage.clear());

await page.goto(
  `http://localhost:13000/?session_first=1&token=${encodeURIComponent(token)}&server_url=${encodeURIComponent(STAGING_WS)}#/`,
);

for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(1000);
  const reconnecting = await page.getByText('Reconnecting…').count();
  const login = await page.getByLabel('Server URL').count();
  const shell = await page.locator('[data-testid="session-first-shell"]').count();
  if (shell || login) {
    console.log(JSON.stringify({ seconds: i + 1, reconnecting, login, shell, done: true }));
    break;
  }
  if (i === 14) {
    console.log(JSON.stringify({ seconds: i + 1, reconnecting, login, shell, done: false }));
  }
}

await page.screenshot({ path: path.join(OUT, 'staging-direct-ws.png'), fullPage: true });

const attach = page.getByRole('button', { name: /attach/i }).first();
if (await attach.count()) {
  await attach.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'staging-direct-terminal.png'), fullPage: true });
  console.log('capsule:', await page.getByTestId('terminal-capsule').count());
}

await browser.close();
