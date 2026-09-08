import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

const token = execSync(
  'kubectl get secret nession-secret-staging -n nession -o jsonpath="{.data.auth-token}" | base64 -d',
  { encoding: 'utf8' },
).trim();

const browser = await chromium.launch();
const page = await browser.newPage();

const result = await page.evaluate(async ({ token }) => {
  const events = [];
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://staging.nession.nhome.local/ws');
    const timeout = setTimeout(() => resolve({ events, error: 'timeout' }), 12000);
    ws.onopen = () => {
      events.push('open');
      ws.send(JSON.stringify({
        msg_type: 'client.auth',
        id: 'auth-1',
        timestamp: Date.now(),
        payload: { auth_token: token, client_id: 'pw-test' },
      }));
    };
    ws.onmessage = (ev) => {
      events.push('message');
      clearTimeout(timeout);
      resolve({ events, message: JSON.parse(ev.data) });
      ws.close();
    };
    ws.onerror = () => events.push('error');
    ws.onclose = (ev) => {
      events.push(`close:${ev.code}`);
      if (events.includes('message')) return;
      clearTimeout(timeout);
      resolve({ events, code: ev.code, reason: ev.reason });
    };
  });
}, { token });

console.log(JSON.stringify(result, null, 2));
await browser.close();
