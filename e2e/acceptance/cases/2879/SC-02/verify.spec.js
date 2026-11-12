'use strict';
// #2879 SC-02: mount -> detach -> reparent -> dispose, and a renderer
// replacement, must not leave a host naming an obsolete xterm. The host
// debug/E2E reference is released by identity, and an ordinary same-Session
// reattach keeps the intended xterm buffer.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { openLifecycleFixture } = require('../../../shared/terminal-memory-lifecycle-cases.cjs');

test('SC-02: host terminal references are reclaimed by identity without losing the buffer', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');
  await openLifecycleFixture(page);

  const observed = await page.evaluate(async () => {
    const lifecycle = window.clipboardHarness.lifecycle;
    const waitForTail = async (needle) => {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const snapshot = lifecycle.snapshot();
        if (snapshot.bufferTail.includes(needle)) { return snapshot; }
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      throw new Error('buffer never showed ' + needle);
    };

    window.clipboardHarness.emit('RETAIN-MARK-A\r\nRETAIN-MARK-B\r\n');
    const mounted = await waitForTail('RETAIN-MARK-B');

    // Reparent while still attached: the old host must lose the reference.
    lifecycle.attachNewHost();
    const reparented = lifecycle.snapshot();

    // Detach from the new host: no host may name the Terminal.
    lifecycle.detach();
    const detached = lifecycle.snapshot();

    // Ordinary same-Session reattach: same Terminal, same buffer.
    lifecycle.attachNewHost();
    const reattached = lifecycle.snapshot();

    return { mounted, reparented, detached, reattached };
  });

  expect(observed.mounted.hosts[0].reference).toBe('live');
  expect(observed.reparented.hosts[0].reference).toBe('none');
  expect(observed.reparented.hosts.at(-1).reference).toBe('live');
  expect(observed.detached.terminalId).toBeNull();
  expect(observed.detached.hosts.every((host) => host.reference === 'none')).toBe(true);
  expect(observed.reattached.terminalId).toBe(observed.mounted.terminalId);
  expect(observed.reattached.bufferTail).toContain('RETAIN-MARK-B');

  const disposed = await page.evaluate(() => {
    window.clipboardHarness.lifecycle.disposeController();
    return window.clipboardHarness.lifecycle.snapshot();
  });
  expect(disposed.terminalId).toBeNull();
  expect(disposed.hosts.every((host) => host.reference === 'none')).toBe(true);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': mounted host=live; reparent cleared the old host and ' +
      'named the new one; detach left every host=none; same-Session reattach kept terminal id ' +
      observed.reattached.terminalId + ' and buffer tail RETAIN-MARK-B; disposal left no host ' +
      'reference',
  });
});
