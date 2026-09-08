import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const token = execSync(
  'kubectl get secret nession-secret-staging -n nession -o jsonpath="{.data.auth-token}" | base64 -d',
  { encoding: 'utf8' },
).trim();

const browser = await chromium.launch();
const page = await browser.newPage();

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

await page.goto('http://localhost:13000/');
await page.evaluate(() => localStorage.clear());

await page.goto(
  `http://localhost:13000/?session_first=1&token=${encodeURIComponent(token)}&server_url=${encodeURIComponent('ws://localhost:19090/ws')}#/`,
);

for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  const reconnecting = await page.getByText('Reconnecting…').count();
  const login = await page.getByLabel('Server URL').count();
  const shell = await page.locator('[data-testid="session-first-shell"]').count();
  const filter = await page.locator('[data-testid="filter-row"]').count();
  console.log(`t=${i + 1}s reconnecting=${reconnecting} login=${login} shell=${shell} filter=${filter}`);
  if (shell || filter || login) break;
}

console.log('console:', logs.filter((l) => !l.includes('DevTools') && !l.includes('vite')).join('\n'));
await browser.close();
