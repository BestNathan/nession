import { test, expect } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';
import { restartAgent } from '../../helpers/runtimeControl';
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
  test(`alternate screen survives an authoritative resize and exits cleanly over ${mode}`, async ({ page, browser }, testInfo) => {
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

    // The TUI reads input instead of sleeping so the bracketed-paste mode it
    // asked for can be measured at the PTY: `-icanon -echo` hands bytes to
    // `cat -v` as they arrive, and `cat -v` makes the ESC bytes it receives
    // visible in the alternate screen. Signals stay enabled (`-icanon`, not
    // `raw`), so the Ctrl+C below still interrupts it.
    await submitTerminalCommand(
      page,
      `printf '\\033[?1049h'; printf '\\033[?1h\\033[?1000h\\033[?2004h'; ` +
        `printf 'ALT-%s-TUI\\n' 2130; stty -icanon -echo min 1 time 0; cat -v`,
    );

    await expect(async () => {
      expect(await readBufferType(page)).toBe('alternate');
      expect(await readTerminalBuffer(page)).toContain('ALT-2130-TUI');
    }).toPass({ timeout: 15_000 });

    // #1926 SC-07 — bracketed paste. The TUI asked for it (`?2004h`); a paste
    // delivered through the terminal's paste path must reach the PTY wrapped
    // in `ESC[200~ ... ESC[201~`, not as bare text. `cat -v` prints exactly the
    // bytes it received, so the wrapper is observable in the alternate screen.
    await page.evaluate(() => {
      const textarea = document.querySelector('.xterm-helper-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error('xterm helper textarea missing');
      }
      const data = new DataTransfer();
      data.setData('text/plain', 'PASTE-2130-MARKER');
      textarea.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }));
    });
    await expect.poll(
      async () => countInBuffer(page, 'PASTE-2130-MARKER'),
      { timeout: 15_000 },
    ).toBe(1);
    expect(
      await readTerminalBuffer(page),
      'the paste reached the PTY without bracketed-paste markers',
    ).toMatch(/\^\[\[200~PASTE-2130-MARKER\^\[\[201~/);

    // #1926 SC-07 — fidelity is a declaration, and a TUI capture must not
    // claim full VT. A second client attaching while the alternate screen owns
    // the terminal receives a bootstrap; its declared fidelity is the only
    // place the screen-only/partial-vs-full-VT distinction exists on the wire.
    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      const secondWire: WireRecord = { sent: [], received: [] };
      other.on('websocket', (socket) => {
        socket.on('framereceived', (frame) => {
          if (typeof frame.payload === 'string') {
            secondWire.received.push(parseFrame(frame.payload));
          }
        });
      });
      await other.goto(
        '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
      );
      await waitForShell(other);
      await attachToSession(other, sessionName, mode);
      await expect.poll(
        () => secondWire.received.filter(
          (frame) => frame.msg_type === 'agent.terminal.output'
            && frame.payload?.bootstrap !== undefined,
        ).length,
        { timeout: 30_000 },
      ).toBeGreaterThan(0);
      const bootstrap = secondWire.received.find(
        (frame) => frame.msg_type === 'agent.terminal.output'
          && frame.payload?.bootstrap !== undefined,
      )?.payload?.bootstrap as Record<string, unknown>;
      console.log(`TUI-BOOTSTRAP-FIDELITY ${JSON.stringify({
        fidelity: bootstrap.fidelity,
        cut: bootstrap.cut_consistency,
        truncated: bootstrap.truncated,
        requested: bootstrap.requested_lines,
      })}`);
      expect(
        bootstrap.fidelity,
        'a pane capture must never be declared full VT',
      ).not.toBe('full-vt');
      expect(['screen-only', 'partial']).toContain(bootstrap.fidelity);
      expect(typeof bootstrap.truncated, 'truncation must be stated').toBe('boolean');
    } finally {
      await second.close();
    }

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

    // Interrupt the TUI, restore the tty the TUI changed, then leave the
    // alternate screen from the shell.
    await sendRawToTerminal(page, '\x03');
    await submitTerminalCommand(page, `stty sane; printf '\\033[?1049l'; echo ALT-2130-BACK`);

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

    // SC-01: the controller's output reaches the observer, and the lease the
    // Agent stated is visible as state — the view-only affordance — rather
    // than inferred from the route (#2157).
    await submitTerminalCommand(controller, `printf 'MULTI-%s-LIVE\\n' 2144`);
    await expect.poll(async () => countInBuffer(observer, 'MULTI-2144-LIVE')).toBe(1);
    await expect(observer.getByTestId('terminal-observer-bar')).toBeVisible();
    await expect(controller.getByTestId('terminal-observer-bar')).toHaveCount(0);

    // SC-03: the observer's input and resize never reach the PTY. Its client
    // knows it is the observer and refuses them locally; the Agent enforces
    // the same rule. The controller's buffer and tty are the witnesses that
    // neither attempt reached the shared session.
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

    // SC-02: acquiring control over the relay moves the lease, and both
    // clients see it — the observer's bar leaves, the controller's appears,
    // and acquiring back restores the original holder for the rest of the
    // fixture.
    await observer.getByRole('button', { name: 'Take control' }).click();
    await expect(observer.getByTestId('terminal-observer-bar')).toHaveCount(0, { timeout: 10_000 });
    await expect(controller.getByTestId('terminal-observer-bar')).toBeVisible({ timeout: 10_000 });
    await controller.getByRole('button', { name: 'Take control' }).click();
    await expect(controller.getByTestId('terminal-observer-bar')).toHaveCount(0, { timeout: 10_000 });
    await expect(observer.getByTestId('terminal-observer-bar')).toBeVisible({ timeout: 10_000 });

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

// #2160: a reconnect during a high-volume burst must not replay events the
// renderer already displayed. Main's full E2E gate reproduced a 1,608-line
// duplicated tail under load; this fixture forces one re-attach deterministically
// and reports the bootstrap markers the client received so a failure names the
// path that replayed.
test('an under-burst reconnect never replays already-parsed output (#2160)', async ({ page }, testInfo) => {
  test.skip(!process.env.CI, 'real stack available in CI only');
  test.setTimeout(360_000);

  const sessionName = `e2e-consistency-replay-${testInfo.retry}-${Date.now()}`;
  const bootstraps: Array<Record<string, unknown>> = [];
  const sockets: string[] = [];
  page.on('websocket', (socket) => {
    sockets.push(socket.url());
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') { return; }
      try {
        const msg = JSON.parse(frame.payload) as {
          msg_type?: string;
          payload?: { bootstrap?: unknown };
        };
        if (msg.msg_type === 'agent.terminal.output' && msg.payload?.bootstrap) {
          bootstraps.push(msg.payload.bootstrap as Record<string, unknown>);
        }
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
  await attachToSession(page, sessionName, 'P2P');
  await waitForInteractiveShell(page);

  const COUNT = 3_000;
  const TAIL = 1_000;
  await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/DR-/'`);

  // Let the burst get well ahead of the parser before the cut.
  await expect(async () => {
    const tail = await readBufferTail(page);
    const seen = [...tail.matchAll(/DR-(\d+)/g)].map((match) => Number(match[1]));
    expect(Math.max(0, ...seen)).toBeGreaterThanOrEqual(800);
  }).toPass({ timeout: 120_000 });

  // Suppress the liveness probe's ping. Typing triggers the probe (#1264); its
  // 5 s deadline tears the socket down, the service rebuilds the same URL, and
  // the runtime re-attaches with a resume while the burst still streams.
  const socketsBefore = sockets.length;
  await page.evaluate(() => {
    const state = window as unknown as { __e2eDroppedPings?: number };
    state.__e2eDroppedPings = 0;
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        try {
          if ((JSON.parse(data) as { msg_type?: string }).msg_type === 'control.ping') {
            state.__e2eDroppedPings = (state.__e2eDroppedPings ?? 0) + 1;
            return;
          }
        } catch {
          // Non-JSON frames pass through unchanged.
        }
      }
      return original.call(this, data);
    };
  });
  await sendRawToTerminal(page, ' ');

  // The witness that this fixture cut the stream at all: the probe must have
  // asked (a ping was dropped) and the runtime must have rebuilt the socket.
  // Without both, a green duplicate assertion would mean nothing happened.
  await expect(async () => {
    const dropped = await page.evaluate(
      () => (window as unknown as { __e2eDroppedPings?: number }).__e2eDroppedPings ?? 0,
    );
    expect(dropped, 'the liveness probe never fired').toBeGreaterThan(0);
    expect(sockets.length, 'the transport was never rebuilt').toBeGreaterThan(socketsBefore);
  }).toPass({ timeout: 30_000 });

  await waitForLastLine(page, 'DR-', COUNT, { timeoutMs: 240_000, stallMs: 60_000 });

  const text = await readTerminalBuffer(page);
  const counts = new Map<number, number>();
  for (const match of text.matchAll(/DR-(\d+)/g)) {
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
  expect(
    duplicated,
    `a tail line was replayed over parsed output; bootstraps=${JSON.stringify(bootstraps.slice(-4))}`,
  ).toEqual([]);
  expect(missingTail, 'a tail line never reached the parser').toEqual([]);
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

  // #1926 SC-08: a fresh attach whose atomic cut was parsed is the one case
  // the runtime may call synchronized. The surface publishes the runtime's
  // answer as a contract attribute, so the state is asserted rather than
  // inferred from which notice happens to render.
  const streamState = (): Promise<string | null> =>
    page.getByTestId('terminal-surface').getAttribute('data-terminal-stream-state');
  await expect.poll(streamState, { timeout: 30_000 }).toBe('synchronized');

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

  // Suppress the liveness probe's ping and make every P2P candidate
  // unreachable. Typing triggers the probe (#1264); once it reports the
  // socket unresponsive, the WebSocketService rebuilds it — and that rebuild
  // must fail too, or it would just reconnect the same healthy URL and the
  // route policy would never run. Only the Server socket (the Relay path) is
  // allowed through. The counters are the witnesses that the fixture cut the
  // stream at all: without them a green assertion would mean nothing happened.
  await page.evaluate(() => {
    const state = window as unknown as {
      __e2eDroppedPings?: number;
      __e2eBlockedAgentConnects?: number;
    };
    state.__e2eDroppedPings = 0;
    state.__e2eBlockedAgentConnects = 0;
    const Original = window.WebSocket;
    const isServerSocket = (raw: string | URL): boolean => {
      try {
        return new URL(String(raw)).port === '19090';
      } catch {
        return false;
      }
    };
    const Guarded = function (url: string | URL, protocols?: string | string[]) {
      if (!isServerSocket(url)) {
        state.__e2eBlockedAgentConnects = (state.__e2eBlockedAgentConnects ?? 0) + 1;
        throw new Error('e2e: agent transport intentionally unavailable');
      }
      return new Original(url, protocols);
    } as unknown as typeof WebSocket;
    Guarded.prototype = Original.prototype;
    Object.setPrototypeOf(Guarded, Original);
    window.WebSocket = Guarded;

    const originalSend = Original.prototype.send;
    Original.prototype.send = function (data) {
      if (typeof data === 'string') {
        try {
          if ((JSON.parse(data) as { msg_type?: string }).msg_type === 'control.ping') {
            state.__e2eDroppedPings = (state.__e2eDroppedPings ?? 0) + 1;
            return;
          }
        } catch {
          // Non-JSON frames pass through unchanged.
        }
      }
      return originalSend.call(this, data);
    };
  });

  // A burst that spans the cut.
  const COUNT = 800;
  const TAIL = 200;
  await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/RS-/'`);

  // One input is enough: the probe deadline tears the P2P socket down, and
  // the blocked rebuild lets AddressAttachPolicy retire its candidates and
  // force Relay. No further typing is needed to reach the policy.
  await sendRawToTerminal(page, ' ');

  // #1926 SC-08: the cut is the moment the tri-state must stop claiming
  // synchronization. The runtime revokes the P2P baseline; a stale
  // `synchronized` here would be exactly the false claim SC-03 forbids.
  await expect.poll(streamState, { timeout: 30_000 }).not.toBe('synchronized');

  await expect(async () => {
    const seen = await page.evaluate(() => {
      const state = window as unknown as {
        __e2eDroppedPings?: number;
        __e2eBlockedAgentConnects?: number;
      };
      return {
        droppedPings: state.__e2eDroppedPings ?? 0,
        blockedConnects: state.__e2eBlockedAgentConnects ?? 0,
      };
    });
    expect(seen.droppedPings, 'the liveness probe never fired').toBeGreaterThan(0);
    expect(seen.blockedConnects, 'no P2P transport rebuild was attempted').toBeGreaterThan(0);
    expect(relayStarted(), 'the Auto route must reach force-relay').toBe(true);
  }).toPass({ timeout: 90_000 });

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

  // #1926 SC-08: the recovered route may be synchronized or degraded-live
  // depending on whether its bootstrap proved a baseline — but a visible
  // degraded notice and a synchronized claim may never coexist.
  const recoveredState = await streamState();
  expect(['synchronized', 'degraded-live', 'unavailable']).toContain(recoveredState);
  if (await page.getByTestId('terminal-history-degraded').count() > 0) {
    expect(
      recoveredState,
      'a visible degraded notice must not coexist with a synchronized claim',
    ).toBe('degraded-live');
  }

  // The renderer survived and the controller can still write.
  await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-route-instance', 'original');
  expect(await countInBuffer(page, 'ROUTE-2156-BEFORE')).toBe(1);
  await submitTerminalCommand(page, `printf 'ROUTE-%s-AFTER\\n' 2156`);
  await expect.poll(async () => countInBuffer(page, 'ROUTE-2156-AFTER'), { timeout: 20_000 })
    .toBe(1);
});

// #1926 SC-05: an Agent restart is the fault that invalidates every in-memory
// stream position at once — a new process, a new stream epoch, and tmux
// sessions that outlived it. The client must recover on the same renderer and
// must not present the boundary as synchronized when it cannot prove the
// history it lost.
//
// The restart is real: the harness stops the Agent process and starts a fresh
// one on the same port over the same tmux server, so the Session's PTY and
// scrollback survive while every epoch, replay ring and parser cursor belongs
// to a process that no longer exists. Both routes are exercised because they
// reach the restart through different owners: P2P loses its browser socket,
// Relay loses the Server's tunnel (which must close the browser connection so
// the client re-attaches instead of sitting on a frozen terminal, #2179).
for (const mode of ['Relay', 'P2P'] as const) {
  test(`an Agent restart recovers without claiming unproven history over ${mode} (#1926 SC-05)`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    test.setTimeout(360_000);

    // #2194 diagnostics, always visible in the selected lane: the wire decides
    // why a recovery lost history. It records which attaches asked for a
    // bootstrap, what cut/fidelity the Agent declared, whether a resume was
    // attempted, and whether the recovered route was Relay — the facts the
    // runtime's own state cannot show after the fact.
    const wire: WireRecord = { sent: [], received: [] };
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => {
        if (typeof frame.payload === 'string') { wire.sent.push(parseFrame(frame.payload)); }
      });
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload === 'string') { wire.received.push(parseFrame(frame.payload)); }
      });
    });

    const sessionName = `e2e-consistency-restart-${mode.toLowerCase()}-${testInfo.retry}-${Date.now()}`;
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, mode);
    await waitForInteractiveShell(page);

    await page.locator('.xterm').evaluate((node) => {
      node.setAttribute('data-e2e-restart-instance', 'original');
    });

    // Deliberately no xterm-node identity assertion here. An Agent restart is
    // a full transport loss (the process that owned the epoch is replaced), and
    // the recovery path is allowed to rebuild the renderer around a fresh
    // verified bootstrap; #2156 owns "same node across a route change". What
    // must hold is that the session recovers and that whatever history it
    // could not prove is stated, which the assertions below cover.
    await submitTerminalCommand(page, `printf 'RESTART-%s-BEFORE\\n' 1926`);
    await expect.poll(async () => countInBuffer(page, 'RESTART-1926-BEFORE')).toBe(1);

    await restartAgent();

    // Recovery: input works again on the surviving tmux session. The command
    // is retried because it can be typed while the transport is still
    // re-attaching; every attempt prints the same marker, and the assertion is
    // about the stream recovering at all, not about input deduplication.
    await expect(async () => {
      await submitTerminalCommand(page, `printf 'RESTART-%s-AFTER\\n' 1926`);
      await expect
        .poll(async () => countInBuffer(page, 'RESTART-1926-AFTER'), { timeout: 10_000 })
        .toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // No silent skip at the boundary. tmux history normally survives, so the
    // pre-restart line should be repainted by the new Agent's bootstrap. If it
    // is not, the runtime must say so with the degraded notice rather than
    // showing a continuous-looking terminal.
    //
    // This part is asserted on the Relay case, which owns the route across the
    // restart. A P2P attach does not: the product's reconnect policy is Auto,
    // and a P2P loss of a manual attach can legitimately recover through Relay.
    // An epoch change with a kept buffer must still state the gap there — that
    // is #2194's contract and its own witness, not something this fixture
    // assumes before the fix lands.
    const before = await countInBuffer(page, 'RESTART-1926-BEFORE');
    expect(before, 'the pre-restart line was duplicated across recovery').toBeLessThanOrEqual(1);
    if (mode === 'Relay' && before === 0) {
      await expect(page.getByTestId('terminal-history-degraded')).toBeVisible({ timeout: 10_000 });
    }

    const rendererSurvived = await page
      .locator('.xterm[data-e2e-restart-instance="original"]')
      .count();
    const degraded = await page.getByTestId('terminal-history-degraded').count();
    const bootstraps = wire.received
      .filter((frame) => frame.msg_type === 'agent.terminal.output'
        && frame.payload?.bootstrap !== undefined)
      .map((frame) => {
        const bootstrap = frame.payload?.bootstrap as Record<string, unknown>;
        return {
          requested: bootstrap.requested_lines,
          cut: bootstrap.cut_consistency,
          fidelity: bootstrap.fidelity,
          truncated: bootstrap.truncated,
          epoch: bootstrap.stream_epoch,
          through: bootstrap.through_seq,
        };
      });
    console.log(`AGENT-RESTART-WIRE ${JSON.stringify({
      mode,
      before,
      degraded,
      rendererSurvived: rendererSurvived === 1,
      attaches: wire.sent
        .filter((frame) => frame.msg_type === 'agent.attach')
        .map((frame) => frame.payload?.needs_bootstrap),
      resumes: wire.sent.filter((frame) => frame.msg_type === 'agent.terminal.stream.resume').length,
      relayBegins: wire.sent.filter((frame) => frame.msg_type === 'server.session.relay.begin').length,
      relayReady: wire.received
        .filter((frame) => frame.msg_type === 'server.session.relay.ready')
        .map((frame) => ({
          epoch: frame.payload?.stream_epoch,
          generation: frame.payload?.subscriber_generation,
        })),
      bootstraps: bootstraps.slice(-4),
    })}`);

    // A second post-restart command proves the recovered route is stable, not
    // a one-frame attach.
    await expect(async () => {
      await submitTerminalCommand(page, `printf 'RESTART-%s-STABLE\\n' 1926`);
      await expect
        .poll(async () => countInBuffer(page, 'RESTART-1926-STABLE'), { timeout: 10_000 })
        .toBeGreaterThan(0);
    }).toPass({ timeout: 60_000 });
  });
}

// #1926 SC-05: the burst that is larger than every in-memory window at once.
// The Agent's replay ring is bounded by events, xterm's scrollback by lines,
// and this fixture deliberately crosses both. Two things are asserted that the
// 5k witnesses cannot see:
//
// 1. the controller's *parser* is starved (the page's main thread blocks for
//    two seconds mid-burst — the xterm parser runs exactly there), and the
//    retained tail still arrives exactly once; and
// 2. after the burst the client reconnects with an applied cursor the Agent's
//    ring no longer holds, and the runtime states that history may be
//    incomplete instead of continuing a buffer it cannot prove.
test('a 100k-line burst survives parser starvation and a retention-lost reconnect (#1926 SC-05)', async ({ page }, testInfo) => {
  test.skip(!process.env.CI, 'real stack available in CI only');
  test.setTimeout(900_000);

  const sessionName = `e2e-consistency-big-${testInfo.retry}-${Date.now()}`;
  await page.goto(
    '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
  );
  await waitForShell(page);
  await createSession(page, sessionName);
  await attachToSession(page, sessionName, 'Relay');
  await waitForInteractiveShell(page);

  // 100k numbered lines: far beyond the Agent's 4096-event ring and the
  // browser's scrollback, so the tail is the only synchronizable window.
  // `sed` block-buffers ~500 bytes per write rather than one write per line;
  // the numbers themselves are the witness.
  const COUNT = 100_000;
  const TAIL = 5_000;
  await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/BIG-/'`);

  // Starve the parser deterministically. This is the slow-Parser fault: the
  // page cannot read its socket or parse a byte while this loop runs, so the
  // transport and Agent buffers must hold the burst rather than lose it or
  // evict a subscriber that is merely not scheduled. The measured shape of
  // this burst is ~2 000 PTY-sized chunks; the terminal writer's event bound
  // has to hold them (512 did not — it overflowed and halted after ~5-8k
  // displayed lines; see `SerializedTerminalWriter`'s measured default).
  await page.evaluate(() => new Promise<void>((resolve) => {
    const until = performance.now() + 2_000;
    while (performance.now() < until) { /* deliberately block the page */ }
    resolve();
  }));

  await waitForLastLine(page, 'BIG-', COUNT, { timeoutMs: 600_000, stallMs: 120_000 });

  const text = await readTerminalBuffer(page);
  const counts = new Map<number, number>();
  for (const match of text.matchAll(/BIG-(\d+)/g)) {
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
  expect(missingTail, 'a tail line never reached the starved parser').toEqual([]);

  // Retention overflow: force a new physical Server socket while the relay's
  // applied cursor sits far above the Agent's retained window. No replay can
  // cover that stretch, so the client must either obtain a complete capture
  // or say that its history may be incomplete. Continuing silently is the
  // failure this asserts against.
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

  const newSocket = page.waitForEvent('websocket', {
    predicate: (ws) => ws.url().includes('/ws'),
    timeout: 30_000,
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await newSocket;
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 60_000 });

  // The tail may be repainted by a fresh capture or explicitly marked
  // degraded; what may not happen is a missing tail with no statement.
  const tailLine = await countInBuffer(page, `BIG-${COUNT}`);
  if (tailLine === 0) {
    await expect(page.getByTestId('terminal-history-degraded')).toBeVisible({ timeout: 15_000 });
  }

  // The recovered route is still usable.
  await submitTerminalCommand(page, `printf 'BIG-%s-AFTER\\n' 1926`);
  await expect.poll(async () => countInBuffer(page, 'BIG-1926-AFTER'), { timeout: 30_000 })
    .toBe(1);
});

// #1926 SC-05: ANSI bursts. The plain numbered bursts prove stream identity;
// this one proves the same path under escape traffic — every line is wrapped
// in SGR colour/cursor sequences, so a parser that desynchronizes on ESC does
// not merely render wrong, it loses or repeats line identity. Asserted as the
// retained tail exactly once, which catches both a dropped line and a double
// delivery even when the visible text still looks plausible.
for (const mode of ['Relay', 'P2P'] as const) {
  test(`an ANSI-coloured numbered burst reaches the parser exactly once over ${mode} (#1926 SC-05)`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    test.setTimeout(300_000);

    const sessionName = `e2e-consistency-ansi-${mode.toLowerCase()}-${testInfo.retry}-${Date.now()}`;
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, mode);
    await waitForInteractiveShell(page);

    const COUNT = 2_000;
    const TAIL = 500;
    // awk builds the SGR wrapper per line; the typed command carries literal
    // backslash escapes, so the command line echoed by the PTY never matches
    // `ANSI-<digits>`.
    await submitTerminalCommand(
      page,
      `seq 1 ${COUNT} | awk '{printf "\\033[3%dmANSI-%d\\033[0m\\n", ($1 % 8), $1}'`,
    );

    await waitForLastLine(page, 'ANSI-', COUNT, { timeoutMs: 180_000, stallMs: 45_000 });

    const text = await readTerminalBuffer(page);
    const counts = new Map<number, number>();
    for (const match of text.matchAll(/ANSI-(\d+)/g)) {
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
    expect(duplicated, 'an ANSI-wrapped line was delivered more than once').toEqual([]);
    expect(missingTail, 'an ANSI-wrapped tail line never reached the parser').toEqual([]);
  });
}
