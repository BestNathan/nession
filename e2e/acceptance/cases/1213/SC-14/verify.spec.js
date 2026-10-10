'use strict';
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, createAndAttach, command, countInBuffer, assertTerminalContinuous } =
  require('../../../shared/foreground-resume-browser.cjs');

test('SC-14: bounded reconnect exhaustion shows offline/Retry without clearing durable Terminal', async ({ page, context }, info) => {
  test.setTimeout(110000);
  const { runtime, sha, contract } = verifiedRuntime('SC-14');
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
  const { name } = await createAndAttach(page, expect, runtime, 'case-1213-14');
  await command(page, "printf 'DEGRADED-BEFORE-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, 'DEGRADED-BEFORE-1213')).toBe(1);
  const offline = page.getByText('Connection unavailable', { exact: true });
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(offline).toBeHidden();
  await expect(retry).toBeHidden();

  try {
    await context.setOffline(true);
    await page.evaluate(() => {
      for (const ws of window.__nession1213Sockets) {
        if (ws.url.includes('/ws') && ws.readyState === WebSocket.OPEN) {
          ws.close(4000, 'simulate persistent unreachable server');
        }
      }
    });
    // Retry is delayed until the configured 5-attempt transport budget is
    // exhausted (1s+2s+4s+8s+16s), never on the first transient loss.
    await expect(page.getByTestId('shell')).toBeVisible();
    await expect(retry).toBeHidden();
    await expect(retry).toBeVisible({ timeout: 65000 });
    await expect(offline).toBeVisible();
    await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');
  } finally {
    await context.setOffline(false);
  }
  await retry.click();
  await assertTerminalContinuous(page, expect, 'DEGRADED-BEFORE', 'DEGRADED-AFTER');
  await expect(offline).toBeHidden({ timeout: 10000 });
  const evidence = {
    issue: 1213, criterion: 'SC-14', target_sha: sha, contract_sha256: contract,
    real_stack: true, selected_session: name, relay: true,
    unavailable_after_retry_exhaustion: true, explicit_retry: true,
    shell_and_terminal_preserved: true, post_retry_pty_works: true,
  };
  await info.attach('sc-14-degraded-retry-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
