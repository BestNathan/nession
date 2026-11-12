// #3358 SC-04: a Server WebSocket outage does not unmount the Workspace or
// send an authenticated user to Login. The page stays visible; every new
// socket is made unreachable for longer than the fast reconnect budget, then
// the fault is cleared and the same xterm/terminal instance must accept input
// again. The xterm marker is the remount witness.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  attachToSession,
  countInBuffer,
  createSession,
  readTerminalBuffer,
  submitTerminalCommand,
} from '../../../../helpers/terminalRegression';
import { waitForShell } from '../../../../helpers/shell';
import {
  dropAllSockets,
  installWebSocketFaultInjector,
  setWebSocketFault,
} from '../../../shared/server-ws-faults';

const runtime = JSON.parse(
  fs.readFileSync(String(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE), 'utf8'),
) as { target_sha: string; server_port: number };

async function waitForTerminal(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 45_000 });
  await expect(page.getByTestId('terminal-loading')).toBeHidden({ timeout: 45_000 });
}

/** Submit until the marker is parsed; a fresh PTY may still be attaching. */
async function waitForMarker(
  page: import('@playwright/test').Page,
  marker: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await submitTerminalCommand(page, `printf '%s\\n' '${marker}'`);
        return countInBuffer(page, marker);
      },
      { timeout: 45_000, intervals: [1_000, 2_000, 4_000] },
    )
    .toBeGreaterThanOrEqual(1);
}

test('SC-04: Server WS outage keeps the attached Workspace and recovers without reload or Login', async ({ page }) => {
  test.setTimeout(105_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await installWebSocketFaultInjector(page);

  const name = `e2e-3358-sc04-${Date.now()}`;
  await page.goto(
    '/?token=e2e-test-token&server_url=' +
      encodeURIComponent('ws://127.0.0.1:' + runtime.server_port + '/ws'),
  );
  await waitForShell(page);
  await createSession(page, name);
  await attachToSession(page, name, 'Relay');
  await waitForTerminal(page);
  await page.locator('.xterm').evaluate((node) => {
    node.setAttribute('data-e2e-3358-instance', 'original');
  });
  const before = `SC04-3358-BEFORE-${Date.now()}`;
  await waitForMarker(page, before);
  expect(await countInBuffer(page, before)).toBeGreaterThanOrEqual(1);

  // Longer than the 1+2+4+8+16s fast budget: the transport must enter its
  // long tail while the page stays visible.
  await setWebSocketFault(page, true);
  await dropAllSockets(page);
  await page.waitForTimeout(33_000);

  // The authenticated surface survived: no Login form, same xterm node, and
  // the buffered output was not discarded.
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.locator('#authToken')).toHaveCount(0);
  await expect(page.getByText('Connect to Server')).toHaveCount(0);
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-3358-instance', 'original');
  expect(await countInBuffer(page, before)).toBeGreaterThanOrEqual(1);

  // Network recovery: the same transport/terminal resumes I/O with no reload.
  await setWebSocketFault(page, false);
  await waitForTerminal(page);
  const after = `SC04-3358-AFTER-${Date.now()}`;
  await waitForMarker(page, after);
  expect(await countInBuffer(page, after)).toBeGreaterThanOrEqual(1);
  expect(await countInBuffer(page, before)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-3358-instance', 'original');
  expect((await readTerminalBuffer(page)).includes(before)).toBe(true);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a visible Relay Terminal survived a 33s Server WS outage past the fast ' +
      'reconnect budget; the same xterm instance and buffered output stayed mounted with no Login ' +
      'form, and I/O resumed after recovery without reload',
  });
});
