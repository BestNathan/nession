'use strict';
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, attachExisting, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

test('SC-11: background controller loses ownership to independent peer and stays Observer after recovery', async ({ page, context, browser }, info) => {
  test.setTimeout(110000);
  const { runtime, sha, contract } = verifiedRuntime('SC-11');
  // Observe actual A physical transports before initial navigation.
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
  const { name } = await createAndAttach(page, expect, runtime, 'case-1213-11', 'P2P');
  const observerA = page.getByTestId('terminal-observer-bar');
  await expect(observerA).toBeHidden();
  await command(page, "printf 'ORIGINAL-CONTROLLER-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, 'ORIGINAL-CONTROLLER-1213')).toBe(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Separate browser context is vital: each context owns an independent
  // stable client_id. Two pages in a shared context do not prove handoff.
  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await attachExisting(peer, expect, runtime, name, 'P2P');
    const observerB = peer.getByTestId('terminal-observer-bar');
    // P2P attach completion and React's terminal-control subscription are
    // separate async boundaries. A one-shot isVisible() immediately after
    // xterm appears may return false before the second client's Observer
    // lease is rendered, silently skipping the intended takeover. Prove the
    // Observer precondition and perform the explicit handoff unconditionally.
    await expect(observerB).toBeVisible({ timeout: 20000 });
    await observerB.getByRole('button', { name: 'Take control' }).click();
    await expect(observerB).toBeHidden({ timeout: 20000 });
    await expect(observerA).toBeVisible({ timeout: 20000 });

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Force a genuine A transport replacement, while B remains connected.
    const prior = await page.evaluate(() => window.__nession1213Sockets.length);
    try {
      await context.setOffline(true);
      await page.evaluate(() => {
        for (const ws of window.__nession1213Sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.close(4000, 'foreground client transport lost');
        }
      });
      await expect(observerA).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
    await expect.poll(async () => page.evaluate(oldCount =>
      window.__nession1213Sockets.length > oldCount &&
      window.__nession1213Sockets.some((socket, i) =>
        i >= oldCount && socket.readyState === WebSocket.OPEN),
    prior), { timeout: 30000 }).toBe(true);
    await expect(observerA).toBeVisible({ timeout: 30000 });
    await expect(observerB).toBeHidden();

    // Observer A may view output, but a stale client may not emit tty input.
    await command(page, "printf 'STALE-CONTROL-%s\\n' 1213");
    await page.waitForTimeout(1200);
    expect(await countInBuffer(peer, 'STALE-CONTROL-1213')).toBe(0);

    await command(peer, "printf 'VALID-CONTROLLER-%s\\n' 1213");
    await expect.poll(() => countInBuffer(peer, 'VALID-CONTROLLER-1213'), { timeout: 25000 }).toBe(1);
    await expect.poll(() => countInBuffer(page, 'VALID-CONTROLLER-1213'), { timeout: 25000 }).toBe(1);
    await expect(observerA).toBeVisible();
    const evidence = {
      issue: 1213, criterion: 'SC-11', target_sha: sha, contract_sha256: contract,
      selected_session: name, two_independent_browser_contexts: true,
      mode: 'P2P', control_transferred_while_backgrounded: true,
      foreground_and_reconnect_kept_observer: true, observer_input_not_delivered: true,
      controller_input_delivered: true,
    };
    await info.attach('sc-11-control-handoff-evidence.json', {
      body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
    });
    console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
  } finally {
    await peerContext.close();
  }
});
