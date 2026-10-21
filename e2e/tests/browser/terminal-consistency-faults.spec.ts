import { test, expect } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';
import {
  createSession,
  attachToSession,
  waitForInteractiveShell,
  readTerminalBuffer,
  readBufferType,
  readGrid,
  countInBuffer,
  waitForStableGrid,
  sendRawToTerminal,
  submitTerminalCommand,
  expectPtySize,
} from '../../helpers/terminalRegression';

// #1645 SC-10 / #1926 SC-05: a high-rate numbered burst must reach the xterm
// parser exactly once per line — no hole a replay was supposed to fill and no
// duplicate from a snapshot/live overlap. The count is deliberately larger
// than any single frame or queue chunk the Agent emits, so a dropped or
// replayed frame shows up as a missing/duplicated number rather than passing
// on a small sample.
const COUNT = 5_000;
// The check window is the tail: xterm's scrollback budget is profile-dependent
// (10k mobile / 50k desktop), and losing the oldest lines to scrollback is
// correct behavior, not a stream defect. A hole in the tail is not.
const TAIL = 2_000;

/** One decoded browser↔runtime frame, as much as the diagnostic needs. */
type WireRecord = {
  sent: WireFrame[];
  received: WireFrame[];
};
type WireFrame = {
  id?: string;
  msg_type?: string;
  payload?: Record<string, unknown>;
};

function parseFrame(raw: string): WireFrame {
  try {
    const value = JSON.parse(raw) as WireFrame;
    return { id: value.id, msg_type: value.msg_type, payload: value.payload };
  } catch {
    return {};
  }
}

// Read only the last rows while the burst is still streaming. Serializing the
// whole buffer on every poll blocks the page's event loop long enough
// that the WebSocket stops draining, which is a property of the witness, not
// of the stream under test. The full buffer is read once, after the last line.
async function readBufferTail(
  page: import('@playwright/test').Page,
  lines = 40,
): Promise<string> {
  return page.evaluate((count) => {
    const xtermEl = document.querySelector('.xterm');
    const container = xtermEl?.parentElement;
    const term = (container as Record<string, unknown>)?.xtermInstance as
      | { buffer: { active: { length: number; getLine(y: number): { translateToString(): string } | undefined } } }
      | undefined;
    if (!term) { return ''; }
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.length - count);
    const out: string[] = [];
    for (let i = start; i < buffer.length; i += 1) {
      out.push(buffer.getLine(i)?.translateToString() ?? '');
    }
    return out.join('\n');
  }, lines);
}

/**
 * Wait until `prefix${last}` is present in the tail, failing on a genuine
 * stall rather than on a slow environment.
 *
 * The stream is allowed to be slow: a saturated runner parses a burst far
 * slower than an idle one (measured ~15–25 lines/s on contended runners
 * against a handful of seconds for the whole burst on an idle one), and that
 * is a property of the witness, not of the exactly-once guarantee. What is
 * not allowed is a stream that stops advancing — every poll reports the
 * highest numbered line seen, and a tail that does not advance for `stallMs`
 * fails naming the position, so a real hole reports itself instead of burning
 * the whole bound.
 */
async function waitForLastLine(
  page: import('@playwright/test').Page,
  prefix: string,
  last: number,
  { timeoutMs, stallMs }: { timeoutMs: number; stallMs: number },
): Promise<void> {
  const start = Date.now();
  const pattern = new RegExp(`${prefix}(\\d+)`, 'g');
  let highest = 0;
  let advancedAt = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tail = await readBufferTail(page);
    const values = [...tail.matchAll(pattern)].map((match) => Number(match[1]));
    const seen = values.length > 0 ? Math.max(...values) : 0;
    if (seen > highest) {
      highest = seen;
      advancedAt = Date.now();
    }
    // The line's presence is the parsed number, not a line-shape match: xterm
    // reports each row space-padded to the full width, so `HV-5000` at the
    // end of the tail is `HV-5000` followed by padding, never end-of-line.
    if (highest >= last) { return; }
    if (Date.now() - advancedAt > stallMs) {
      const grid = await readGrid(page);
      throw new Error(
        `${prefix}${last} stream stalled at ${prefix}${highest} for ${stallMs}ms ` +
          `(grid ${grid.cols}x${grid.rows})`,
      );
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `${prefix}${last} did not arrive within ${timeoutMs}ms; highest was ${prefix}${highest}`,
  );
}

for (const mode of ['Relay', 'P2P'] as const) {
  test(`high-volume numbered output reaches the parser exactly once over ${mode}`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    // Session creation/attach plus the burst. The readiness wait is
    // progress-bounded (see waitForLastLine): a slow parser is tolerated, a
    // stalled one fails with its position.
    test.setTimeout(360_000);

    const sessionName = `e2e-consistency-hv-${mode.toLowerCase()}-${testInfo.retry}-${Date.now()}`;
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, mode);
    await waitForInteractiveShell(page);

    // The echoed command line spells `HV-/` but no `HV-<digits>`, so every
    // numeric match below comes from the stream output itself. Waiting for the
    // LAST line — not a `echo DONE` marker, whose text is echoed at the prompt
    // the moment the command is submitted — is what makes the buffer read a
    // complete prefix rather than a mid-stream sample.
    //
    // `sed` is the producer: its stdout is block-buffered, so the pane's tty
    // receives ~500-byte writes rather than one write per line. The burst's
    // delivery rate is the environment's (see waitForLastLine); the 5,000-line
    // count and the tail window are the witness and stay fixed.
    await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/HV-/'`);

    await waitForLastLine(page, 'HV-', COUNT, { timeoutMs: 300_000, stallMs: 60_000 });

    const text = await readTerminalBuffer(page);
    const counts = new Map<number, number>();
    for (const match of text.matchAll(/HV-(\d+)/g)) {
      const value = Number(match[1]);
      if (value >= 1 && value <= COUNT) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }

    // A separate-process (PTY) bootstrap is explicitly unverified: a producer
    // racing the capture can put a prefix line in both the snapshot and the
    // live stream. That prefix is outside the synchronized guarantee, and the
    // criterion scopes duplicates to the retained tail alongside missing
    // lines. A tail line delivered twice is still a failure.
    const duplicated = [...counts.entries()]
      .filter(([value, seen]) => seen > 1 && value > COUNT - TAIL)
      .map(([value]) => value);
    const missingTail: number[] = [];
    for (let value = COUNT - TAIL + 1; value <= COUNT; value += 1) {
      if (!counts.has(value)) {
        missingTail.push(value);
      }
    }

    expect(duplicated, 'a line was delivered more than once').toEqual([]);
    expect(missingTail, 'a line in the tail window never reached the parser').toEqual([]);
  });
}

// #2130 / #1926 SC-07: a screen that owns the terminal. The alternate screen
// must stay the active buffer through an authoritative resize, receive the
// same size the browser grid reports, and leave no TUI content in normal
// scrollback when it exits. Markers are built from printf arguments so the
// command line the PTY echoes never contains the resolved marker.
for (const mode of ['Relay', 'P2P'] as const) {
  test(`alternate screen survives an authoritative resize and exits cleanly over ${mode}`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    test.setTimeout(120_000);

    // #2132: the PTY drops a resize made while an alt-screen TUI owns the
    // screen. tmux itself follows the command (probed directly), so the frame
    // is lost between the browser and the Agent's write. Record both sides:
    // what the page sent and how the Agent answered, so a failure names the
    // layer instead of only reporting the stale `stty size`.
    const wire: WireRecord = { sent: [], received: [] };
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => {
        if (typeof frame.payload === 'string') { wire.sent.push(parseFrame(frame.payload)); }
      });
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload === 'string') { wire.received.push(parseFrame(frame.payload)); }
      });
    });

    const sessionName = `e2e-consistency-tui-${mode.toLowerCase()}-${testInfo.retry}-${Date.now()}`;
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, mode);
    await waitForInteractiveShell(page);

    await submitTerminalCommand(
      page,
      `printf '\\033[?1049h'; printf '\\033[?1h\\033[?1000h\\033[?2004h'; ` +
        `printf 'ALT-%s-TUI\\n' 2130; while :; do sleep 0.5; done`,
    );

    await expect(async () => {
      expect(await readBufferType(page)).toBe('alternate');
      expect(await readTerminalBuffer(page)).toContain('ALT-2130-TUI');
    }).toPass({ timeout: 15_000 });

    // The controller suppresses the PTY half of a resize while the webfont is
    // still loading (`metricsAreProvisional`), but still resizes the local
    // grid. Wait for the face before measuring, or the grid moves while the
    // PTY legitimately does not follow.
    await waitForStableGrid(page);
    await page.evaluate(async () => { await document.fonts.ready; });

    // The browser grid changes while the TUI owns the screen: the alternate
    // buffer must stay active and the pane must report the same size from
    // inside it.
    const before = await readGrid(page);
    // Grow, not shrink: tmux keeps the largest attached client's size, and
    // the suite's PTY-follow proof (#1187) is a growth assertion.
    await page.setViewportSize({ width: 1600, height: 1000 });
    let after = before;
    await expect(async () => {
      after = await readGrid(page);
      expect(after.rows).toBeGreaterThan(before.rows);
    }).toPass({ timeout: 15_000 });

    // Browser-visible only: the alternate buffer stays active and keeps its
    // content through the reflow. Whether the PTY itself follows a resize
    // during a TUI is tracked separately (the Agent side is proven; the
    // browser lane still drops it in some runs).
    await expect(async () => {
      expect(await readBufferType(page)).toBe('alternate');
      expect(await readTerminalBuffer(page)).toContain('ALT-2130-TUI');
    }).toPass({ timeout: 15_000 });

    // #2132: the resize has left the browser by now (it is sent from the same
    // observer fire that moved the grid, after a 200 ms debounce). Ask the
    // wire which side dropped it: no frame names the browser, an `error` reply
    // names the Agent, and a frame with an `ok` reply means the Agent wrote a
    // resize tmux did not apply.
    await page.waitForTimeout(1_500);
    const resizeFrames = wire.sent.filter((frame) => frame.msg_type === 'agent.terminal.resize');
    const lastResize = resizeFrames.at(-1);
    const resizeReplies = lastResize === undefined
      ? []
      : wire.received.filter((frame) => frame.id === lastResize.id);
    const wireSummary = JSON.stringify({
      sent: resizeFrames.slice(-3).map((frame) => ({
        cols: frame.payload?.cols, rows: frame.payload?.rows, session: frame.payload?.session_name,
      })),
      replies: resizeReplies.map((frame) => ({
        msg_type: frame.msg_type, code: frame.payload?.code,
      })),
      captured: wire.sent.length,
      lastSent: wire.sent.slice(-6).map((frame) => frame.msg_type),
      fonts: await page.evaluate(() => document.fonts.status),
      grid: after,
      sessionName,
    });
    // Always visible in the selected lane: a passing wire assertion still has
    // to say *which* frame carried the size and how the Agent answered.
    console.log(`TUI-RESIZE-WIRE ${wireSummary}`);
    expect(resizeFrames.length, `no resize left the browser: ${wireSummary}`).toBeGreaterThan(0);
    expect(
      resizeReplies.filter((frame) => frame.msg_type === 'error'),
      `the Agent refused the TUI resize: ${wireSummary}`,
    ).toEqual([]);

    // Interrupt the loop, then leave the alternate screen from the shell.
    await sendRawToTerminal(page, '\x03');
    await submitTerminalCommand(page, `printf '\\033[?1049l'; echo ALT-2130-BACK`);

    await expect(async () => {
      expect(await readBufferType(page)).toBe('normal');
      expect(await readTerminalBuffer(page)).toContain('ALT-2130-BACK');
    }).toPass({ timeout: 15_000 });

    // The authoritative half: the pane's own tty now reports the size the
    // browser grid showed while the TUI owned the screen (#2132).
    await expectPtySize(page, after.cols, after.rows);

    // Nothing owned by the alternate screen may leak into normal scrollback.
    expect(await countInBuffer(page, 'ALT-2130-TUI')).toBe(0);

  });
}

// #2141 / #1926 SC-03: a Relay reconnect must keep the live renderer and its
// stream. The reconnect is forced deterministically with the #1213 shape: the
// browser keeps a half-open Server socket, and a visibility cycle makes the
// bounded probe open a new physical socket. The xterm node identity proves the
// Terminal was not remounted; the markers and the numbered tail prove no
// output was lost or duplicated across the cut.
test('a Relay reconnect keeps the xterm and loses no session output', async ({ page }, testInfo) => {
  test.skip(!process.env.CI, 'real stack available in CI only');
  test.setTimeout(240_000);

  const sessionName = `e2e-consistency-reconnect-${testInfo.retry}-${Date.now()}`;
  await page.goto(
    '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
  );
  await waitForShell(page);
  await createSession(page, sessionName);
  await attachToSession(page, sessionName, 'Relay');
  await waitForInteractiveShell(page);

  await page.locator('.xterm').evaluate((node) => {
    node.setAttribute('data-e2e-reconnect-instance', 'original');
  });

  // printf arguments keep the resolved marker out of the echoed command line.
  await submitTerminalCommand(page, `printf 'RECONNECT-%s-BEFORE\\n' 2141`);
  await expect.poll(async () => countInBuffer(page, 'RECONNECT-2141-BEFORE')).toBe(1);

  await page.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        try {
          if ((JSON.parse(data) as { msg_type?: string }).msg_type === 'server.info') {
            return;
          }
        } catch {
          // Non-JSON frames still pass through unchanged.
        }
      }
      return originalSend.call(this, data);
    };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Register before the foreground event so the reconnect cannot race the
  // subscription: a new physical /ws socket is the witness.
  const newSocket = page.waitForEvent('websocket', {
    predicate: (ws) => ws.url().includes('/ws'),
    timeout: 20_000,
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await newSocket;
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-reconnect-instance', 'original');
  await expect.poll(async () => countInBuffer(page, 'RECONNECT-2141-BEFORE')).toBe(1);

  await submitTerminalCommand(page, `printf 'RECONNECT-%s-AFTER\\n' 2141`);
  await expect.poll(async () => countInBuffer(page, 'RECONNECT-2141-AFTER'), { timeout: 20_000 })
    .toBe(1);

  // A numbered burst after recovery: the tail must be present exactly once.
  const COUNT = 1_000;
  const TAIL = 400;
  await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/RC-/'`);
  await waitForLastLine(page, 'RC-', COUNT, { timeoutMs: 150_000, stallMs: 45_000 });

  const text = await readTerminalBuffer(page);
  const counts = new Map<number, number>();
  for (const match of text.matchAll(/RC-(\d+)/g)) {
    const value = Number(match[1]);
    if (value >= 1 && value <= COUNT) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const duplicated = [...counts.entries()]
    .filter(([value, seen]) => seen > 1 && value > COUNT - TAIL)
    .map(([value]) => value);
  const missingTail: number[] = [];
  for (let value = COUNT - TAIL + 1; value <= COUNT; value += 1) {
    if (!counts.has(value)) { missingTail.push(value); }
  }
  expect(duplicated, 'a tail line was delivered more than once').toEqual([]);
  expect(missingTail, 'a tail line never reached the parser').toEqual([]);
});

// #2144 / #1926 SC-06: two real clients on one Session. The browser client id
// is persisted in localStorage, so two pages in one context are one client to
// the Agent; the observer must be a separate browser context with its own
// storage or the ControlLease would never distinguish the two.
test('two clients: a stalled observer never blocks the controller (#2144)', async ({ browser }, testInfo) => {
  test.skip(!process.env.CI, 'real stack available in CI only');
  test.setTimeout(420_000);

  const sessionName = `e2e-consistency-multi-${testInfo.retry}-${Date.now()}`;
  const url = '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws');
  const controllerContext = await browser.newContext();
  const observerContext = await browser.newContext();
  const controller = await controllerContext.newPage();
  const observer = await observerContext.newPage();
  try {
    await controller.goto(url);
    await waitForShell(controller);
    await createSession(controller, sessionName);
    await attachToSession(controller, sessionName, 'Relay');
    await waitForInteractiveShell(controller);

    await observer.goto(url);
    await waitForShell(observer);
    // The session was created in the other context; the list is server-wide,
    // so the observer sees it through the ordinary refresh path.
    const row = observer.locator('[data-testid="session-item-row"]', { hasText: sessionName });
    await expect(async () => {
      const refresh = observer.getByRole('button', { name: 'Refresh sessions' });
      if (await refresh.isVisible().catch(() => false)) { await refresh.click(); }
      await expect(row).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await attachToSession(observer, sessionName, 'Relay');
    await waitForInteractiveShell(observer);

    // SC-01: the controller's output reaches the observer.
    await submitTerminalCommand(controller, `printf 'MULTI-%s-LIVE\\n' 2144`);
    await expect.poll(async () => countInBuffer(observer, 'MULTI-2144-LIVE')).toBe(1);

    // SC-03: the observer's input and resize never reach the PTY. Lease
    // *visibility* over Relay is Bug #2157 — today the observer cannot see its
    // role (the Server's relay-ready carries no control fields), so its client
    // may still send. The enforcement witness is the Agent: the observer's
    // bytes and size never reach the shared session, and the controller's
    // buffer and tty are unchanged.
    await submitTerminalCommand(observer, `printf 'OBSERVER-%s-INPUT\\n' 2144`);
    await expect.poll(async () => countInBuffer(controller, 'OBSERVER-2144-INPUT')).toBe(0);
    const controllerGrid = await readGrid(controller);
    // Larger than the controller's: tmux follows the largest client, so a
    // leaked observer resize would visibly move the shared pane.
    await observer.setViewportSize({ width: 1700, height: 1100 });
    await expect(async () => {
      expect((await readGrid(observer)).cols).toBeGreaterThan(controllerGrid.cols);
    }).toPass({ timeout: 15_000 });
    await expectPtySize(controller, controllerGrid.cols, controllerGrid.rows);

    // SC-02: stall the observer's main thread — its socket stops draining —
    // and prove the controller still receives the burst's retained tail
    // exactly once. The stall outlasts the burst on a slow runner.
    const COUNT = 600;
    const TAIL = 200;
    const stalled = observer
      .evaluate(() => new Promise<void>((resolve) => {
        const until = performance.now() + 120_000;
        while (performance.now() < until) { /* deliberately block the page */ }
        resolve();
      }))
      .catch(() => undefined);
    await submitTerminalCommand(controller, `seq 1 ${COUNT} | sed 's/^/MC-/'`);
    await waitForLastLine(controller, 'MC-', COUNT, { timeoutMs: 180_000, stallMs: 45_000 });

    const text = await readTerminalBuffer(controller);
    const counts = new Map<number, number>();
    for (const match of text.matchAll(/MC-(\d+)/g)) {
      const value = Number(match[1]);
      if (value >= 1 && value <= COUNT) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const duplicated = [...counts.entries()]
      .filter(([value, seen]) => seen > 1 && value > COUNT - TAIL)
      .map(([value]) => value);
    const missingTail: number[] = [];
    for (let value = COUNT - TAIL + 1; value <= COUNT; value += 1) {
      if (!counts.has(value)) { missingTail.push(value); }
    }
    expect(duplicated, 'a tail line was delivered more than once').toEqual([]);
    expect(missingTail, 'a tail line never reached the parser').toEqual([]);

    // The controller is still the controller after the stall.
    await submitTerminalCommand(controller, `printf 'MULTI-%s-AFTER\\n' 2144`);
    await expect.poll(async () => countInBuffer(controller, 'MULTI-2144-AFTER')).toBe(1);
    await stalled;
  } finally {
    await controllerContext.close();
    await observerContext.close();
  }
});

// #2156 / #1926 SC-03: the live route change the product actually performs.
// The UI has no manual switch while attached (the session gear only saves the
// mode for the next attach, and a manual P2P route that disconnects ends in
// transport-exhausted). Under Auto, when the P2P candidates stop answering,
// AddressAttachPolicy calls force-relay and the runtime re-attaches over Relay
// without tearing down the renderer.
test('an Auto P2P loss falls back to Relay without remounting the xterm (#2156)', async ({ page }, testInfo) => {
  test.skip(!process.env.CI, 'real stack available in CI only');
  test.setTimeout(360_000);

  const sessionName = `e2e-consistency-route-${testInfo.retry}-${Date.now()}`;
  const sentWire: Array<{ msg_type?: string }> = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      if (typeof frame.payload !== 'string') { return; }
      try {
        sentWire.push(JSON.parse(frame.payload) as { msg_type?: string });
      } catch {
        // Non-JSON frames are not protocol messages.
      }
    });
  });

  await page.goto(
    '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
  );
  await waitForShell(page);
  await createSession(page, sessionName);
  await attachToSession(page, sessionName, 'Auto');
  await waitForInteractiveShell(page);

  const relayStarted = (): boolean =>
    sentWire.some((frame) => frame.msg_type === 'server.session.relay.begin');
  // Auto must have chosen the direct route, or this fixture would not exercise
  // a switch at all.
  expect(relayStarted(), 'Auto attach must start on the P2P route').toBe(false);

  await page.locator('.xterm').evaluate((node) => {
    node.setAttribute('data-e2e-route-instance', 'original');
  });
  await submitTerminalCommand(page, `printf 'ROUTE-%s-BEFORE\\n' 2156`);
  await expect.poll(async () => countInBuffer(page, 'ROUTE-2156-BEFORE')).toBe(1);

  // Suppress the liveness probe's ping. The peer is still alive but stops
  // answering the runtime's question — the half-open transport the probe
  // exists to catch (#1264). Typing triggers the probe (onInputSent). Once
  // the probe reports the socket unresponsive, the WebSocketService's attempt
  // to rebuild it must fail too, or it would just reconnect the same healthy
  // URL and never reach the route policy: guard the constructor for
  // non-Server URLs and arm it here (the Server socket is already open and
  // keeps working for the relay).
  await page.evaluate(() => {
    const Original = window.WebSocket;
    let blockAgentTransport = false;
    const Guarded = function (url: string | URL, protocols?: string | string[]) {
      if (blockAgentTransport && !String(url).includes('localhost:19090/ws')) {
        throw new Error('e2e: agent transport intentionally unavailable');
      }
      return new Original(url, protocols);
    } as unknown as typeof WebSocket;
    Guarded.prototype = Original.prototype;
    Object.setPrototypeOf(Guarded, Original);
    window.WebSocket = Guarded;
    (
      window as unknown as { __e2eBlockAgentTransport?: () => void }
    ).__e2eBlockAgentTransport = () => {
      blockAgentTransport = true;
    };

    const originalSend = Original.prototype.send;
    Original.prototype.send = function (data) {
      if (typeof data === 'string') {
        try {
          if ((JSON.parse(data) as { msg_type?: string }).msg_type === 'control.ping') {
            return;
          }
        } catch {
          // Non-JSON frames pass through unchanged.
        }
      }
      return originalSend.call(this, data);
    };
    (
      window as unknown as { __e2eBlockAgentTransport?: () => void }
    ).__e2eBlockAgentTransport?.();
  });

  // A burst that spans the cut.
  const COUNT = 800;
  const TAIL = 200;
  await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/RS-/'`);

  // Each unanswered probe (5 s deadline) retires a P2P candidate; when the
  // last one is gone the Auto route forces Relay. A space is harmless to the
  // shell and still counts as input at the transport.
  for (let attempt = 0; attempt < 6 && !relayStarted(); attempt += 1) {
    await sendRawToTerminal(page, ' ');
    await page.waitForTimeout(6_500);
  }
  expect(
    relayStarted(),
    'the Auto route must reach force-relay once its P2P candidates stop answering',
  ).toBe(true);

  await waitForLastLine(page, 'RS-', COUNT, { timeoutMs: 240_000, stallMs: 60_000 });

  const text = await readTerminalBuffer(page);
  const counts = new Map<number, number>();
  for (const match of text.matchAll(/RS-(\d+)/g)) {
    const value = Number(match[1]);
    if (value >= 1 && value <= COUNT) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const duplicated = [...counts.entries()]
    .filter(([value, seen]) => seen > 1 && value > COUNT - TAIL)
    .map(([value]) => value);
  const missingTail: number[] = [];
  for (let value = COUNT - TAIL + 1; value <= COUNT; value += 1) {
    if (!counts.has(value)) { missingTail.push(value); }
  }
  expect(duplicated, 'a tail line was delivered more than once across the fallback').toEqual([]);
  expect(missingTail, 'a tail line never reached the parser across the fallback').toEqual([]);

  // The renderer survived and the controller can still write.
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-route-instance', 'original');
  expect(await countInBuffer(page, 'ROUTE-2156-BEFORE')).toBe(1);
  await submitTerminalCommand(page, `printf 'ROUTE-%s-AFTER\\n' 2156`);
  await expect.poll(async () => countInBuffer(page, 'ROUTE-2156-AFTER'), { timeout: 20_000 })
    .toBe(1);
});
