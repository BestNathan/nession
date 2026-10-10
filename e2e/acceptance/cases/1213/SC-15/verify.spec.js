'use strict';
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, createAndAttach, command, countInBuffer, assertTerminalContinuous } =
  require('../../../shared/foreground-resume-browser.cjs');

test('SC-15: visible desktop loses/recover network; same Session, xterm and PTY input', async ({ page, context }, info) => {
  const { runtime, sha, contract } = verifiedRuntime('SC-15');
  // Capture the very first real /ws socket before page navigation/handshake.
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.__nession1213Sockets = [];
    window.WebSocket = new Proxy(Original, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args);
        window.__nession1213Sockets.push(socket);
        return socket;
      },
    });
  });

  const { name } = await createAndAttach(page, expect, runtime, 'case-1213-15');
  await command(page, "printf 'DESKTOP-BEFORE-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, 'DESKTOP-BEFORE-1213'), { timeout: 20000 }).toBe(1);
  const originalCount = await page.evaluate(() => window.__nession1213Sockets.length);
  expect(originalCount).toBeGreaterThan(0);

  // A desktop network loss without visibilitychange, reload, manual Retry or
  // a second attach. Closing a real socket while offline makes the failure
  // deterministic even if Chromium's online/offline notifications are delayed.
  try {
    await context.setOffline(true);
    await page.evaluate(() => {
      for (const ws of window.__nession1213Sockets) {
        if (ws.url.includes('/ws') && ws.readyState === WebSocket.OPEN) {
          ws.close(4000, 'desktop network disconnected');
        }
      }
    });
    await expect(page.getByTestId('shell')).toBeVisible();
    await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');
    await page.waitForTimeout(1500);
  } finally {
    await context.setOffline(false);
  }
  await expect.poll(async () => page.evaluate(oldCount =>
    window.__nession1213Sockets.length > oldCount &&
      window.__nession1213Sockets.some((socket, index) =>
        index >= oldCount && socket.url.includes('/ws') && socket.readyState === WebSocket.OPEN),
  originalCount), { timeout: 30000 }).toBe(true);

  await assertTerminalContinuous(page, expect, 'DESKTOP-BEFORE', 'DESKTOP-AFTER');
  const evidence = {
    issue: 1213, criterion: 'SC-15', target_sha: sha, contract_sha256: contract,
    real_stack: true, session_name: name, mode: 'Relay',
    no_visibility_event: true, network_offline_online: true,
    new_physical_socket: true, terminal_node_preserved: true,
    selected_session_input_works: true,
  };
  await info.attach('sc-15-desktop-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
