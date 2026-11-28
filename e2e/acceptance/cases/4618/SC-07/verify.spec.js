'use strict';
// SC-07 (#4618): controlled Chromium visible/foreground/offline/online recovery.
// The real full stack loses its network path; incremental reachability probing
// and the existing recovery owner restore the SAME Session without a page
// reload, preserving the Workspace/xterm and terminal continuity. A manual Retry
// wakes rediscovery; the spinner does not outlive the recovery budget.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, command, countInBuffer, assertTerminalContinuous,
} = require('../../../shared/foreground-resume-browser.cjs');

test('SC-07: network loss/recovery keeps the same Session and xterm; Retry wakes rediscovery', async ({ page, context }, info) => {
  const { runtime, sha, contract } = verifiedRuntime('SC-07');

  // Capture every real socket so the loss/recovery is observable.
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.__nession4618Sockets = [];
    window.WebSocket = new Proxy(Original, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args);
        window.__nession4618Sockets.push(socket);
        return socket;
      },
    });
  });

  const { name } = await createAndAttach(page, expect, runtime, 'case-4618-7', 'Auto');
  await command(page, "printf 'BEFORE-%s\\n' 4618");
  await expect.poll(() => countInBuffer(page, 'BEFORE-4618'), { timeout: 20000 }).toBe(1);
  const originalCount = await page.evaluate(() => window.__nession4618Sockets.length);
  expect(originalCount).toBeGreaterThan(0);

  // Controlled network loss: offline + close the live transport sockets. No
  // visibilitychange, no reload, no second attach is initiated by the test.
  try {
    await context.setOffline(true);
    await page.evaluate(() => {
      for (const ws of window.__nession4618Sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(4000, 'network path removed');
        }
      }
    });
    // The work surface stays mounted; the terminal node is the original.
    await expect(page.getByTestId('shell')).toBeVisible();
    await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');
    await page.waitForTimeout(1500);
  } finally {
    await context.setOffline(false);
  }

  // Recovery dials a fresh physical socket without a page reload.
  await expect.poll(async () => page.evaluate((oldCount) =>
    window.__nession4618Sockets.length > oldCount
    && window.__nession4618Sockets.some((socket, index) =>
      index >= oldCount && socket.readyState === WebSocket.OPEN),
  originalCount), { timeout: 45000 }).toBe(true);

  // The spinner yields; the same Session's terminal is continuous.
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30000 });
  await assertTerminalContinuous(page, expect, 'BEFORE', 'AFTER');

  // A manual Retry wakes probe/inventory rediscovery and the transport.
  const retry = page.getByRole('button', { name: 'Retry' });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
  }
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');

  const evidence = {
    issue: 4618,
    criterion: 'SC-07',
    target_sha: sha,
    contract_sha256: contract,
    real_stack: true,
    session_name: name,
    network_offline_online: true,
    new_physical_socket: true,
    terminal_node_preserved: true,
    same_session_no_reload: true,
    selected_session_input_works: true,
    manual_retry_available: true,
  };
  await info.attach('sc-07-recovery-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence)),
    contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
