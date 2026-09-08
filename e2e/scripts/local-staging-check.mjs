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

const wsViaVite = encodeURIComponent('ws://localhost:13000/ws');
const wsDirect = encodeURIComponent('ws://localhost:19090/ws');

async function snap(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

const browser = await chromium.launch();
const page = await browser.newPage();

const log = [];
page.on('console', (msg) => log.push(`[${msg.type()}] ${msg.text()}`));

// 1) Stale localStorage + deep link (reproduces Reconnecting)
await page.goto('http://localhost:13000/?session_first=1#/terminal/k8s-agent%3A9');
await page.evaluate(() => {
  localStorage.setItem('nession_token', 'bad-token');
  localStorage.setItem('nession_server_url', 'ws://localhost:13000/ws');
  localStorage.setItem('remember', 'true');
});
await page.reload();
await page.waitForTimeout(3000);
await snap(page, '01-reconnecting-bad-token.png');
const reconnecting1 = await page.getByText('Reconnecting…').count();

// 2) Clear + login via URL params (vite proxy)
await page.evaluate(() => localStorage.clear());
await page.goto(
  `http://localhost:13000/?session_first=1&token=${encodeURIComponent(token)}&server_url=${wsViaVite}#/`,
);
await page.waitForTimeout(5000);
await snap(page, '02-after-autoconnect-vite-proxy.png');
const reconnecting2 = await page.getByText('Reconnecting…').count();
const loginVisible = await page.getByLabel('Server URL').count();
const capsuleHost = await page.locator('[data-terminal-capsule-host]').count();

// 3) Direct WS bypass vite
await page.evaluate(() => localStorage.clear());
await page.goto(
  `http://localhost:13000/?session_first=1&token=${encodeURIComponent(token)}&server_url=${wsDirect}#/`,
);
await page.waitForTimeout(5000);
await snap(page, '03-after-autoconnect-direct-ws.png');
const reconnecting3 = await page.getByText('Reconnecting…').count();
const sessionList = await page.locator('[data-testid="session-list"], [data-testid="session-first-shell"]').count();

// Try attach first session if visible
const attachBtn = page.getByRole('button', { name: /attach/i }).first();
if (await attachBtn.count()) {
  await attachBtn.click();
  await page.waitForTimeout(4000);
  await snap(page, '04-terminal-attached.png');
  const capsule = await page.getByTestId('terminal-capsule').count();
  console.log(JSON.stringify({
    reconnecting1,
    reconnecting2,
    reconnecting3,
    loginVisible,
    capsuleHost,
    sessionList,
    capsule,
    consoleTail: log.slice(-8),
    screenshots: OUT,
  }, null, 2));
} else {
  console.log(JSON.stringify({
    reconnecting1,
    reconnecting2,
    reconnecting3,
    loginVisible,
    capsuleHost,
    sessionList,
    consoleTail: log.slice(-8),
    screenshots: OUT,
  }, null, 2));
}

await browser.close();
