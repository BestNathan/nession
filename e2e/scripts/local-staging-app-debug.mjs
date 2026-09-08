import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const token = execSync(
  'kubectl get secret nession-secret-staging -n nession -o jsonpath="{.data.auth-token}" | base64 -d',
  { encoding: 'utf8' },
).trim();

const STAGING_WS = 'ws://staging.nession.nhome.local/ws';

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

await page.goto('http://localhost:13000/');
await page.evaluate(() => localStorage.clear());

const url = `http://localhost:13000/?session_first=1&token=${encodeURIComponent(token)}&server_url=${encodeURIComponent(STAGING_WS)}#/`;
await page.goto(url);

await page.waitForTimeout(12000);

const state = await page.evaluate(() => ({
  serverUrl: localStorage.getItem('nession_server_url'),
  hasToken: Boolean(localStorage.getItem('nession_token')),
  reconnecting: document.body.innerText.includes('Reconnecting'),
  login: document.body.innerText.includes('Connect to Server'),
  shell: Boolean(document.querySelector('[data-testid="session-first-shell"]')),
}));

console.log(JSON.stringify({ state, logs: logs.filter((l) => !l.includes('vite') && !l.includes('DevTools')) }, null, 2));
await browser.close();
