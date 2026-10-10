'use strict';
const { test, expect, devices } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, command, countInBuffer, assertTerminalContinuous,
} = require('../../../shared/foreground-resume-browser.cjs');

// Headless Chromium, mobile UA/touch/device scale. Start with a wide viewport
// solely for deterministic Session creation/attach, then transition to an
// actual narrow mobile viewport BEFORE any lifecycle assertions. Mobile
// routing and the terminal remain active for the entire recovery exercise.
test.use({
  ...devices['Pixel 7'],
  viewport: { width: 1100, height: 820 },
  browserName: 'chromium',
});

test('SC-17: headless Chrome mobile emulation preserves Session/Terminal across lifecycle and network loss', async ({ page, context, browserName }, info) => {
  test.setTimeout(120_000);
  const { runtime, sha, contract } = verifiedRuntime('SC-17');
  expect(browserName).toBe('chromium');

  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.__mobile1213 = { sockets: [], probes: 0, drops: 0, block: false, blockedSocket: null };
    window.WebSocket = new Proxy(Original, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args);
        window.__mobile1213.sockets.push(socket);
        return socket;
      },
    });
    const send = Original.prototype.send;
    Original.prototype.send = function (data) {
      if (typeof data === 'string') {
        try {
          if (JSON.parse(data).msg_type === 'server.info') {
            window.__mobile1213.probes += 1;
            if (window.__mobile1213.block && this === window.__mobile1213.blockedSocket) {
              window.__mobile1213.drops += 1;
              return; // keep the physical socket OPEN but unresponsive
            }
          }
        } catch { /* ordinary non-JSON transport frames still pass */ }
      }
      return send.call(this, data);
    };
  });

  const { name } = await createAndAttach(page, expect, runtime, 'case-1213-mobile');

  // The actual acceptance lifecycle takes place with a narrow mobile layout
  // and touch-enabled Chromium (not an iOS/WebKit implementation). Transition
  // viewport before establishing the identity marker so a legitimate responsive
  // layout change cannot masquerade as a lifecycle-driven Terminal remount.
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
  await page.locator('.xterm').evaluate(el => el.setAttribute('data-1213-case-instance', 'original'));
  await command(page, "printf 'MOBILE-BEFORE-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, 'MOBILE-BEFORE-1213'), { timeout: 20_000 }).toBe(1);
  const device = await page.evaluate(() => ({
    width: window.innerWidth,
    touch: navigator.maxTouchPoints,
    mobileUA: /Android|Mobile/i.test(navigator.userAgent),
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
  }));
  expect(device.width).toBeLessThanOrEqual(450);
  expect(device.touch).toBeGreaterThan(0);
  expect(device.mobileUA).toBe(true);
  expect(device.pointerCoarse).toBe(true);
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');

  // Healthy background/foreground: a real server.info probe must be sent,
  // and successful liveness must NOT replace a healthy physical Server socket.
  const healthy = await page.evaluate(() => ({
    sockets: window.__mobile1213.sockets.filter(s => s.url.includes('/ws')).length,
    probes: window.__mobile1213.probes,
  }));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange')); // duplicate lifecycle event
  });
  await expect.poll(() => page.evaluate(() => window.__mobile1213.probes), { timeout: 10_000 })
    .toBeGreaterThan(healthy.probes);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__mobile1213.sockets.filter(s => s.url.includes('/ws')).length))
    .toBe(healthy.sockets);

  // Foreground after a silent half-open path: suppress only the old Server
  // socket's typed probe reply; it remains OPEN until the coordinator replaces
  // it. Duplicate events must not unmount xterm or create a reconnect storm.
  const stale = await page.evaluate(() => {
    const state = window.__mobile1213;
    const ws = [...state.sockets].reverse().find(s => s.url.includes('/ws') && s.readyState === WebSocket.OPEN);
    if (!ws) throw new Error('no OPEN server WS to simulate stale connection');
    state.blockedSocket = ws;
    state.block = true;
    return state.sockets.filter(s => s.url.includes('/ws')).length;
  });
  const replacement = page.waitForEvent('websocket', {
    predicate: ws => ws.url().includes('/ws'),
    timeout: 20_000,
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await replacement;
  await expect.poll(() => page.evaluate(() => window.__mobile1213.drops), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.evaluate(() => { window.__mobile1213.block = false; });
  await expect.poll(() => page.evaluate(oldCount =>
    window.__mobile1213.sockets.filter(s => s.url.includes('/ws')).length > oldCount &&
    window.__mobile1213.sockets.some(s => s.url.includes('/ws') && s !== window.__mobile1213.blockedSocket && s.readyState === WebSocket.OPEN),
  stale), { timeout: 30_000 }).toBe(true);
  await assertTerminalContinuous(page, expect, 'MOBILE-BEFORE', 'MOBILE-AFTERPROBE');

  // Real Chromium network offline/online emulation while hidden, not just a
  // synthetic visibility event. The reconnect path must keep the selected
  // Session, terminal DOM and working PTY, with no manual reattach or Login.
  const beforeOffline = await page.evaluate(() => window.__mobile1213.sockets.length);
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await context.setOffline(true);
    await page.evaluate(() => {
      for (const ws of window.__mobile1213.sockets) {
        if (ws.url.includes('/ws') && ws.readyState === WebSocket.OPEN) ws.close(4000, 'mobile emulation offline');
      }
    });
    await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');
    await page.waitForTimeout(1200);
  } finally {
    await context.setOffline(false);
  }
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(oldCount =>
    window.__mobile1213.sockets.length > oldCount &&
    window.__mobile1213.sockets.some((s, i) => i >= oldCount && s.url.includes('/ws') && s.readyState === WebSocket.OPEN),
  beforeOffline), { timeout: 35_000 }).toBe(true);
  await assertTerminalContinuous(page, expect, 'MOBILE-AFTERPROBE', 'MOBILE-AFTERNETWORK');

  const evidence = {
    issue: 1213, criterion: 'SC-17', target_sha: sha, contract_sha256: contract,
    runtime: 'full-stack-local', selected_session: name,
    engine: 'headless Chromium', profile: 'Pixel 7 mobile emulation',
    viewport: { width: 412, height: 915 }, touch: true,
    native_ios_webkit_tested: false,
    healthy_probe_without_socket_replacement: true,
    stale_open_probe_witnessed: true, physical_ws_replaced: true,
    duplicate_visibility_events_injected: true,
    background_offline_online_emulated: true,
    same_xterm_dom: true, terminal_pty_continuous: true,
  };
  await info.attach('sc-17-headless-chromium-mobile-evidence.json', {
    body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
  });
  console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
});
