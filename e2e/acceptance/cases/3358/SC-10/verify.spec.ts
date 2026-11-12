// #3358 SC-10: the compound outage. Both the Server WS and the P2P Agent
// socket are unreachable for longer than the short test credential lease
// (p2p_token_expiry_secs = 8 in this profile) and past the Server fast retry
// budget. After recovery the client must re-authenticate the Server, obtain a
// new scoped P2P credential, re-dial the Agent and resume the same Terminal —
// no reload, no Login, no manual attach. The xterm marker is the remount
// witness and the pre-outage output proves the buffer survived.
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
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-loading')).toBeHidden({ timeout: 30_000 });
}

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

test('SC-10: compound Server+P2P outage past credential TTL resumes the same Terminal without reload', async ({ page }) => {
  test.setTimeout(105_000);
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA ?? '');
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await installWebSocketFaultInjector(page);

  const name = `e2e-3358-sc10-${Date.now()}`;
  await page.goto(
    '/?token=e2e-test-token&server_url=' +
      encodeURIComponent('ws://127.0.0.1:' + runtime.server_port + '/ws'),
  );
  await waitForShell(page);
  await createSession(page, name);
  await attachToSession(page, name, 'P2P');
  await waitForTerminal(page);
  await page.locator('.xterm').evaluate((node) => {
    node.setAttribute('data-e2e-3358-instance', 'original');
  });
  const before = `SC10-3358-BEFORE-${Date.now()}`;
  await waitForMarker(page, before);

  // Outage longer than the 8s test lease and the 31s Server fast budget.
  await setWebSocketFault(page, true);
  await dropAllSockets(page);
  await page.waitForTimeout(36_000);

  // Waiting on the credential issuer must not unmount the surface, send the
  // user to Login, exhaust P2P candidates into Relay, or reset the buffer.
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.locator('#authToken')).toHaveCount(0);
  await expect(page.getByText('Connect to Server')).toHaveCount(0);
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-3358-instance', 'original');
  expect(await countInBuffer(page, before)).toBeGreaterThanOrEqual(1);

  // Recovery: Server auth -> fresh scoped P2P credential -> Agent -> attach.
  await setWebSocketFault(page, false);
  await waitForTerminal(page);
  const after = `SC10-3358-AFTER-${Date.now()}`;
  await waitForMarker(page, after);
  expect(await countInBuffer(page, after)).toBeGreaterThanOrEqual(1);
  expect(await countInBuffer(page, before)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-3358-instance', 'original');
  expect((await readTerminalBuffer(page)).includes(before)).toBe(true);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a 36s Server+P2P outage past the 8s P2P credential lease kept the same ' +
      'xterm instance mounted with no Login; after recovery the client re-authenticated, reissued a ' +
      'scoped credential, re-dialed the Agent and resumed I/O in the same Session without reload',
  });
});
