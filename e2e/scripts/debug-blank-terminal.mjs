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

await page.goto('http://localhost:13000/?session_first=1');
await page.evaluate(({ token }) => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('token', token);
  localStorage.setItem('remember', 'true');
  localStorage.setItem('nession_server_url', 'ws://localhost:13000/ws');
  localStorage.setItem('nession_session_first', '1');
}, { token });
await page.reload();
await page.waitForTimeout(4000);

// Open drawer and attach first session
await page.getByTestId('session-first-open-drawer').click();
await page.waitForTimeout(2000);
const firstSession = page.locator('[data-testid="session-item"]').first();
await firstSession.click();
await page.waitForTimeout(1000);

const attachConfirm = page.getByTestId('attach-confirm');
if (await attachConfirm.count()) {
  await attachConfirm.click();
}

await page.waitForTimeout(15000);

const state = await page.evaluate(() => ({
  url: location.href,
  hasXterm: Boolean(document.querySelector('.xterm')),
  xtermText: document.querySelector('.xterm-screen')?.textContent?.slice(0, 300) ?? '',
  bodySnippet: document.body.innerText.slice(0, 400),
}));

console.log(JSON.stringify({
  state,
  logs: logs.filter((l) =>
    l.includes('P2P') || l.includes('relay') || l.includes('WebSocket') || l.includes('Bridge'),
  ),
}, null, 2));
await browser.close();
