import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const token = execSync(
  'kubectl get secret nession-secret-staging -n nession -o jsonpath="{.data.auth-token}" | base64 -d',
  { encoding: 'utf8' },
).trim();

const browser = await chromium.launch();
const page = await browser.newPage();

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
await page.waitForTimeout(8000);

const state = await page.evaluate(() => ({
  reconnecting: document.body.innerText.includes('Reconnecting'),
  shell: Boolean(document.querySelector('[data-testid="session-first-shell"]')),
  login: document.body.innerText.includes('Connect to Server'),
}));

console.log(JSON.stringify(state));
await browser.close();
