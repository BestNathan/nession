'use strict';
const { test, expect } = require('@playwright/test');
const { verifiedRuntime, createAndAttach, command, countInBuffer, assertTerminalContinuous } =
  require('../../../shared/foreground-resume-browser.cjs');

test('SC-08: selected Relay Session recovers after stale-OPEN foreground probe on exact main SHA', async ({ page }, info) => {
  const { runtime, sha, contract } = verifiedRuntime('SC-08');
  const { name } = await createAndAttach(page, expect, runtime, 'case-1213-08');
  await command(page, "printf 'FOREGROUND-BEFORE-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, 'FOREGROUND-BEFORE-1213'), { timeout: 20000 }).toBe(1);

  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      // Suppress the current socket's foreground no-side-effect liveness request.
      // OPEN is preserved to reproduce a stale transport missed by close/error.
      if (typeof data === 'string') {
        try {
          if (JSON.parse(data).msg_type === 'server.info') return;
        } catch { /* non-JSON is passed through */ }
      }
      return send.call(this, data);
    };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Observer is installed before the foreground event; recovery cannot
  // satisfy the Case by merely keeping old xterm content visible.
  const nextSocket = page.waitForEvent('websocket', {
    predicate: socket => socket.url().includes('/ws'),
    timeout: 15000,
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await nextSocket;
  await assertTerminalContinuous(page, expect, 'FOREGROUND-BEFORE', 'FOREGROUND-AFTER');
  const evidence = {
    issue: 1213, criterion: 'SC-08', target_sha: sha, contract_sha256: contract,
    real_stack: true, session_name: name, mode: 'Relay',
    foreground_probe_timeout: true, new_socket_observed: true,
    terminal_node_preserved: true, selected_session_input_works: true,
  };
  await info.attach('sc-08-foreground-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
