import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCapsuleCapability } from '../../helpers/capsule';
import { waitForShell } from '../../helpers/shell';
import { E2E_TMUX_SOCKET } from '../../runtime';
import {
  readTerminalBuffer,
  readBufferType,
  wheelOverTerminal,
  readScrollMode,
  readViewport,
  readGrid,
  waitForStableGrid,
  waitForTerminal,
  ensureSessionsList,
  createSession,
  attachToSession,
  waitForInteractiveShell,
  sendRawToTerminal,
  submitTerminalCommand,
  expectPtySize,
  countInBuffer,
  ptyProbeInstaller,
  startPtyProbe,
  stopPtyProbe,
  readPane,
  repaintFixtureInstaller,
  lastNonEmptyLine,
  tapCapsuleArrowUp
} from '../../helpers/terminalRegression';

test.describe('Terminal I/O', () => {
  test.beforeEach(async ({ page }) => {
    // Use direct WS URL to bypass vite preview's flaky WS proxy.
    await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'));
    await waitForShell(page);
  });

  test('relay mode: echo command and verify output', async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-terminal-relay-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');

    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, 'echo nession-e2e-ok');

    // Wait for the output to appear in the buffer
    await expect(async () => {
      const text = await readTerminalBuffer(page);
      expect(text).toContain('nession-e2e-ok');
    }).toPass({ timeout: 15_000 });
  });

  test('P2P mode: echo command and verify output', async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-terminal-p2p-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'P2P');

    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, 'echo nession-e2e-ok');

    // Wait for the output to appear in the buffer
    await expect(async () => {
      const text = await readTerminalBuffer(page);
      expect(text).toContain('nession-e2e-ok');
    }).toPass({ timeout: 15_000 });
  });

  test('foreground stale-open Server socket resumes without remounting Terminal (#1213 SC-08/15)', async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');

    const sessionName = `e2e-foreground-1213-${testInfo.retry}-${Date.now()}`;
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, 'Relay');
    await waitForInteractiveShell(page);

    // The Shell is already interactive. Mark the actual xterm DOM node: a
    // recreated Terminal can render the same text but cannot preserve this
    // node-local identity. The test must fail on any Shell/Terminal remount.
    await page.locator('.xterm').evaluate((node) => {
      node.setAttribute('data-e2e-1213-terminal-instance', 'original');
    });
    await submitTerminalCommand(page, "printf 'BEFORE-%s\\n' 1213");
    await expect.poll(async () => countInBuffer(page, 'BEFORE-1213')).toBe(1);

    // Create the half-open shape deterministically: WebSocket.readyState stays
    // OPEN, but the foreground server.info request is never delivered. This
    // deliberately exercises the *bounded probe* rather than depending on
    // whether Chrome happens to emit an onclose during network emulation.
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

    // Register the observer BEFORE the foreground event so a reconnect cannot
    // race the test subscription. A new physical /ws socket is the witness:
    // simply seeing the old terminal remain visible would be a false pass.
    const newSocket = page.waitForEvent('websocket', {
      predicate: (ws) => ws.url().includes('/ws'),
      timeout: 15_000,
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.getByTestId('shell')).toBeVisible();
    await newSocket;
    await expect(page.getByTestId('shell')).toBeVisible();
    await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-1213-terminal-instance', 'original');

    // Same selected Session and same terminal must still accept PTY input.
    await submitTerminalCommand(page, "printf 'AFTER-%s\\n' 1213");
    await expect.poll(async () => countInBuffer(page, 'AFTER-1213'), { timeout: 20_000 }).toBe(1);
    expect(await countInBuffer(page, 'BEFORE-1213')).toBe(1);
    await testInfo.attach('foreground-resume-1213.json', {
      body: Buffer.from(JSON.stringify({
        scenario: 'foreground-stale-open-server',
        transport: 'relay',
        terminalMountPreserved: true,
        newPhysicalSocketObserved: true,
        outputAfterReconnect: 'AFTER-1213',
      })),
      contentType: 'application/json',
    });
  });

  test('desktop reconnect after real network loss preserves Terminal without visibility events (#1213 SC-15)', async ({ page, context }, testInfo) => {
    test.skip(!process.env.CI, 'real Server/Agent/tmux stack runs in CI only');

    // Install socket bookkeeping before the page starts, not after its initial
    // handshake. The second navigation is intentional: otherwise the first
    // live socket predates this observer, making the test a false positive.
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const tracked = window as typeof window & { __e2e1213Sockets?: WebSocket[] };
      tracked.__e2e1213Sockets = [];
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          const socket = Reflect.construct(Target, args) as WebSocket;
          tracked.__e2e1213Sockets?.push(socket);
          return socket;
        },
      });
    });
    await page.reload();
    await waitForShell(page);

    const sessionName = `e2e-desktop-1213-${testInfo.retry}-${Date.now()}`;
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, 'Relay');
    await waitForInteractiveShell(page);
    await page.locator('.xterm').evaluate((node) => {
      node.setAttribute('data-e2e-1213-desktop-instance', 'original');
    });
    await submitTerminalCommand(page, "printf 'DESKTOP-BEFORE-%s\\n' 1213");
    await expect.poll(async () => countInBuffer(page, 'DESKTOP-BEFORE-1213')).toBe(1);

    const baselineSockets = await page.evaluate(() =>
      (window as typeof window & { __e2e1213Sockets?: WebSocket[] }).__e2e1213Sockets?.length ?? 0,
    );
    expect(baselineSockets).toBeGreaterThan(0);

    try {
      // No visibilitychange/pageshow dispatch occurs in this test. Forcing
      // loss of the actual socket (not a mocked service) with the network
      // offline reproduces ordinary desktop transport disconnection.
      await context.setOffline(true);
      await page.evaluate(() => {
        const sockets = (window as typeof window & { __e2e1213Sockets?: WebSocket[] }).__e2e1213Sockets ?? [];
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN && ws.url.includes('/ws')) {
            ws.close(4000, 'desktop network disconnected');
          }
        }
      });
      await expect(page.getByTestId('shell')).toBeVisible();
      await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-1213-desktop-instance', 'original');
      await page.waitForTimeout(1_500);
    } finally {
      await context.setOffline(false);
    }

    // Recovery is entirely automatic — there is no foreground hint, manual
    // Retry, page reload or fresh attach. Assert a new authenticated socket
    // and prove it can drive a real PTY command on the same mounted xterm.
    await expect.poll(async () => page.evaluate(() => {
      const sockets = (window as typeof window & { __e2e1213Sockets?: WebSocket[] }).__e2e1213Sockets ?? [];
      return sockets.filter(ws => ws.url.includes('/ws') && ws.readyState === WebSocket.OPEN).length;
    }), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-1213-desktop-instance', 'original');
    await submitTerminalCommand(page, "printf 'DESKTOP-AFTER-%s\\n' 1213");
    await expect.poll(async () => countInBuffer(page, 'DESKTOP-AFTER-1213'), { timeout: 20_000 }).toBe(1);
    expect(await countInBuffer(page, 'DESKTOP-BEFORE-1213')).toBe(1);
  });

  test('a curses TUI renders and gives the shell back (#1096)', async ({ page }, testInfo) => {
    // Criterion 15's curses smoke. Nothing here is Nession-specific, and that
    // is the point: `less` reads keys in raw mode, paints its own screen from
    // terminfo, and exits on a keystroke. The fixtures in this file drive the
    // PTY with escapes the test itself wrote; this drives it with a program
    // that was written without Nession in mind.
    //
    // It deliberately does not assert on the alternate screen — `less` opens
    // one, and that it did so is the transport's business, not this test's.
    //
    // The reason this used to give was that the alternate screen "is not
    // observable from the browser: tmux owns its client's screen and mouse
    // mode, so `buffer.active.type` reads `'alternate'` for a plain shell too".
    // That was true under `AttachMode::plain` and stopped being true in #321
    // S3, which is exactly what the transport test above now asserts. (The
    // parenthetical naming `pty.rs` as the only option it sets was wrong even
    // then — `manager.rs` sets `mouse on` at session creation.)
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-curses-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    await submitTerminalCommand(page, 'less /etc/hosts');
    // It painted. `localhost` is in /etc/hosts on every runner.
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 15_000 })
      .toContain('localhost');

    // `q` reaches it in raw mode, and only then does tmux repaint the prompt.
    await sendRawToTerminal(page, 'q');
    await expect.poll(async () => lastNonEmptyLine(page), { timeout: 15_000 }).toMatch(/runner:\S*\$/);
  });

  test('a viewport resize reaches the PTY (#1187)', async ({ page }, testInfo) => {
    // The browser's grid and the application's tty size are two different
    // facts, and only the second one means the resize arrived. Both are
    // asserted: the grid changes, and then the Session reports the new size.
    // The first is also the guard — without it the second could pass on a
    // terminal that never noticed anything.
    //
    // What #1187 first recorded as "the PTY never follows on CI" was an
    // artifact of asking the question once, inside the 200 ms window where the
    // grid has already moved and the debounced PTY notification has not
    // (`expectPtySize` above carries the measurement). The assertion below is
    // therefore the same question asked until it is answered.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.setViewportSize({ width: 1280, height: 600 });
    const SESSION_NAME = `e2e-resize-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);
    await waitForStableGrid(page);

    const before = await readGrid(page);
    await expectPtySize(page, before.cols, before.rows);

    // Grow, holding the width. Below roughly 1280 the Web layout stops giving
    // the terminal fewer columns — the sidebar and the well's minimum hold the
    // grid's width and the page scrolls instead — so height is the dimension a
    // window change actually moves.
    await page.setViewportSize({ width: 1280, height: 900 });

    await expect
      .poll(async () => (await readGrid(page)).rows, { timeout: 15_000 })
      .toBeGreaterThan(before.rows);

    const after = await readGrid(page);
    await expectPtySize(page, after.cols, after.rows);
  });

  test('Ctrl+D reaches the PTY instead of disconnecting (#1096 criterion 1)', async ({ page }, testInfo) => {
    // The byte the product used to steal: Nession read `0x04` as its own
    // disconnect. Criterion 1 says the byte must reach the application and
    // disconnect must be an explicit action.
    //
    // The observation is EOF. `cat -v` reading a tty exits when it sees `^D`
    // with nothing pending — so if the byte arrives, the probe ends and the
    // shell prints a fresh prompt. A Nession that still hijacked it would
    // leave `cat` running and print no new prompt.
    //
    // Asserted on the LAST non-empty line, not on a regex over the whole
    // buffer: the scrollback already holds prompts from before the probe was
    // started, so `toMatch(/…$/)` would pass without anything happening. The
    // prompt after the exit is the one the cursor sits on.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-ctrld-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, ptyProbeInstaller());

    await startPtyProbe(page, 'normal');
    await sendRawToTerminal(page, '\x04');
    await expect
      .poll(async () => lastNonEmptyLine(page), { timeout: 15_000 })
      .toMatch(/runner:\S*\$/);
  });

  test('committed non-ASCII text reaches the PTY (#1096 criterion 11)', async ({ page }, testInfo) => {
    // Criterion 11's second half. The first half — that composition sends only
    // *committed* text — is covered where composition happens
    // (`MobileImeInput`), which needs `ontouchstart` and so is not reachable
    // from here. What this proves is the other end: the bytes a commit produces
    // survive the whole path.
    //
    // `sendRawToTerminal` is not a stand-in for the encoder — it *is* it. IME
    // commit and this helper both end at `terminal.input(text, true)`, so the
    // string below travels the same wire the composer would. Everything after
    // it is real: relay, tmux, and the tty line discipline, none of which this
    // test stubs, and none of which is where a multi-byte character is
    // supposed to be lost.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-cjk-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, ptyProbeInstaller());

    // `cat -v` escapes control characters, not non-ASCII, so what comes back in
    // the buffer is what the application received.
    await startPtyProbe(page, 'normal');
    await sendRawToTerminal(page, '中文输入\n');
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 15_000 })
      .toContain('中文输入');
  });

  test('a reattached client still asks in the mode the PTY is in (#1096 criterion 13, case 10)', async ({ page }, testInfo) => {
    // "reconnect/reattach without losing the expected mode after
    // redraw/bootstrap." The mode belongs to the *application*: the pane stays
    // in application-cursor mode across the browser going away and coming back,
    // and the question is whether a freshly built xterm is told so. A client
    // that reattached with its own default would ask for `^[[A` while the
    // application waits for `^[OA` — the failure this case exists for.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-reattach-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, ptyProbeInstaller());

    await startPtyProbe(page, 'appcursor');
    await tapCapsuleArrowUp(page);
    await expect(async () => {
      expect(await countInBuffer(page, '^[OA')).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });

    // A genuinely fresh client: the document reloads and xterm is built from
    // nothing, while the probe keeps running in the pane.
    //
    // No `attachToSession` here, and that is the point rather than a shortcut.
    // The route still names the Session and the attach profile is persisted
    // (#1186), so a reload reattaches on the ordinary path — there is no second
    // confirmation to click, and waiting for one is what this test did first
    // and failed on. Waiting for the shell is waiting for the reattach.
    //
    // Counting `^[OA` before and after rather than asserting presence, because
    // the reattach re-bootstraps the scrollback and the earlier one comes back
    // with it.
    await page.reload();
    await waitForInteractiveShell(page);

    const before = await countInBuffer(page, '^[OA');
    await tapCapsuleArrowUp(page);
    await expect(async () => {
      expect(await countInBuffer(page, '^[OA')).toBeGreaterThan(before);
    }).toPass({ timeout: 15_000 });
  });

  // Both transports, because the size reaches the agent on two different wires
  // and the guard this fixes lives below both of them (#1490 SC-03).
  for (const mode of ['Relay', 'P2P'] as const) {
  test(`a reload re-observes the session without repainting history into it (${mode}, #1490)`, async ({ page }, testInfo) => {
    // The reported symptom, at the level it was reported: a page refresh must
    // re-observe the same Session and leave its history alone. What made it
    // grow was the client asking for a size the pane was never at — a grid
    // measured while the webfont was still loading — and then correcting it, so
    // an attach moved the shared window twice. An inline-drawing application
    // repaints on each SIGWINCH and its repaint scrolls into the history the
    // user reads.
    //
    // The fixture is that application, deterministically: it paints a numbered
    // block and repaints on resize, and prints nothing else. So **the pane is
    // byte-stable between resizes**, and any growth across the reloads below is
    // the client's doing rather than the application's.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-history-${mode.toLowerCase()}-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, mode);
    await waitForInteractiveShell(page);

    await submitTerminalCommand(page, repaintFixtureInstaller());
    await submitTerminalCommand(page, 'bash inline-repaint.sh');

    // The block is painted, and from here only a resize can add a line.
    await expect
      .poll(async () => readPane(SESSION_NAME).markers, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(20);

    // The baseline is the *settled* pane rather than the count right after the
    // fixture started: the attach's own resize is legitimate, and only the
    // reloads below are under test. Two agreeing reads is that condition,
    // the same shape `waitForStableGrid` uses.
    let before = readPane(SESSION_NAME);
    await expect
      .poll(async () => {
        const now = readPane(SESSION_NAME);
        const settled = now.sha === before.sha && now.markers >= 20;
        before = now;
        return settled;
      }, { timeout: 20_000 })
      .toBe(true);

    for (let i = 0; i < 3; i += 1) {
      await page.reload();
      // The snapshot the reload asked for is the whole history — no prompt is
      // on screen for `waitForInteractiveShell` to find, so readiness is the
      // fixture's own last line arriving.
      await expect
        .poll(async () => readTerminalBuffer(page), { timeout: 30_000 })
        .toContain('REPAINT-initial-0020');
    }
    await page.waitForTimeout(1_000);

    // The invariant: with no producer and an unchanged viewport, tmux's history
    // is untouched. The hash is the whole capture, so it catches a change the
    // line count would not — a repaint that replaced lines rather than adding
    // them.
    const after = readPane(SESSION_NAME);
    expect(after.sha).toBe(before.sha);
    expect(after.markers).toBe(before.markers);

    // And the client holds exactly one copy of the history it was sent: not a
    // second copy appended by a re-attach, not a gap where the erase landed.
    const text = await readTerminalBuffer(page);
    expect(text.match(/REPAINT-initial-0020/g) ?? []).toHaveLength(1);
    expect(text.match(/REPAINT-initial-0001/g) ?? []).toHaveLength(1);
  });
  }

  test('reading history does not resize the session or repaint it into its own scrollback (#1503)', async ({ page }, testInfo) => {
    // The capsule reserves a band at the bottom of the well in `following` and
    // releases it in `history`, and that band used to be part of the geometry
    // the PTY was sized from — so scrolling into history moved the shared tmux
    // window (measured 32 ↔ 35 rows) and an inline TUI repainted into the very
    // history the user was reading.
    //
    // Reading is not a container resize, so nothing about the session may
    // change: the same fixture as the #1490 case makes that measurable — it
    // prints nothing but its block, so a repaint is the only way a line can
    // appear.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-scroll-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    await submitTerminalCommand(page, repaintFixtureInstaller());
    await submitTerminalCommand(page, 'bash inline-repaint.sh');

    await expect
      .poll(async () => readPane(SESSION_NAME).markers, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(20);

    // Settle first: the attach's own resize is legitimate, and only the scroll
    // below is under test.
    let before = readPane(SESSION_NAME);
    await expect
      .poll(async () => {
        const now = readPane(SESSION_NAME);
        const settled = now.sha === before.sha && now.markers >= 20;
        before = now;
        return settled;
      }, { timeout: 20_000 })
      .toBe(true);
    const gridBefore = await readGrid(page);

    // Into history and back — the interaction the issue reports, performed the
    // way a user performs it.
    await wheelOverTerminal(page, -300);
    await expect
      .poll(async () => readScrollMode(page), { timeout: 10_000 })
      .toBe('history');
    const gridInHistory = await readGrid(page);
    await wheelOverTerminal(page, 3_000);
    await expect
      .poll(async () => readScrollMode(page), { timeout: 10_000 })
      .toBe('following');
    await page.waitForTimeout(1_000);

    // The session is untouched — same capture, same line count.
    const after = readPane(SESSION_NAME);
    expect(after.sha).toBe(before.sha);
    expect(after.markers).toBe(before.markers);

    // And the client's own grid did not move either: the band is a display
    // clearance, so the size the user types at is the size they browse at.
    // (Sizing to the well instead would draw rows the padding clips, so this
    // is also the assertion that the grid still fits the visible box.)
    expect(gridInHistory).toStrictEqual(gridBefore);
    expect(await readGrid(page)).toStrictEqual(gridBefore);
  });

  test('a restored session still takes input after the reload (#1429)', async ({ page }, testInfo) => {
    // #1429's reported flow: create, use, leave (reload), restore, type.
    //
    // It is a **regression test for the reported behavior, not for a
    // reproduced defect**: the identity work the issue produced — the browser
    // binding its stable id on the P2P socket (#1454), the Server presenting it
    // to the Agent on the relay — changed *who the Agent thinks is typing*, and
    // this flow was expected to pass on both sides of that change. The audit
    // that established that is on the issue; this case is here because the
    // report is what a user sees, and "the restored terminal shows output but
    // takes no input" is the shape worth failing on if it ever comes back.
    //
    // P2P, and only P2P, because it is the transport where the Web decides its
    // own control role and can therefore withhold input locally; on relay the
    // client sends and the Agent authorizes, with no client-side gate to get
    // wrong.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-restore-input-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'P2P');
    await waitForInteractiveShell(page);

    // Typing works before the reload, so what the assertion below measures is
    // the restore rather than a session that never carried input at all.
    await submitTerminalCommand(page, 'echo BEFORE-RESTORE-MARKER');
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 15_000 })
      .toContain('BEFORE-RESTORE-MARKER');

    // A genuinely fresh client: the document reloads and the attach is rebuilt
    // from the persisted profile (#1186), so waiting for the shell is waiting
    // for the restore — there is no second confirmation to click.
    await page.reload();
    await waitForInteractiveShell(page);

    await submitTerminalCommand(page, 'echo AFTER-RESTORE-MARKER');
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 15_000 })
      .toContain('AFTER-RESTORE-MARKER');
  });

  test('reading history does not get dragged to the bottom, and returning does (#321)', async ({ page }, testInfo) => {
    // #321's remaining two criteria, and they are only reachable at all under
    // the default transport: `shouldScrollLocally()` is dead code under Plain
    // (a tmux client owns the screen), so before S3 there was no mode to be in.
    //
    // **The reader must not type while the output arrives.** xterm's
    // `scrollOnUserInput` (default on) scrolls to the bottom on *input*, and
    // `sendRawToTerminal` passes `wasUserInput: true` — so a test that types the
    // command which produces the output is scrolling itself and measuring that.
    // Measured on CI: the first version of this test failed with the viewport at
    // `baseY` and the mode back to `following`, on a change that had not touched
    // the follow logic at all.
    //
    // So the producer is started *before* the wheel and left running: the
    // output arrives with this client sending nothing.
    //
    // Asserted on the product's own signal — `data-terminal-scroll-mode` on the
    // capsule host, written by `occlusionScroll`'s `setMode` — rather than on
    // `viewportY` alone: the mode is what the capsule's inset and every follow
    // decision are keyed on, and a terminal that scrolled locally while still
    // believing it was following would pass a viewport-only assertion.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-follow-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    // Enough output to have somewhere to scroll to, and a producer that keeps
    // going afterwards. Waited on `baseY` — the bottom of the scrollback —
    // rather than on the mode, because the mode is already `following` before
    // any of this output exists and a poll for it would pass without waiting.
    await submitTerminalCommand(page, 'seq 1 200');
    await submitTerminalCommand(
      page,
      'for i in $(seq 1 30); do printf "BROWSING-%02d\\n" $i; sleep 1; done &',
    );
    await expect
      .poll(async () => (await readViewport(page)).baseY, { timeout: 15_000 })
      .toBeGreaterThan(100);
    expect(await readScrollMode(page)).toBe('following');

    // #1482: assert the computed terminal grid clearance, not a CSS string.
    await expect.poll(async () => page.evaluate(() => {
      const viewport = document.querySelector('[data-terminal-viewport]');
      const shell = document.querySelector('[data-testid="capsule-shell"]');
      if (!(viewport instanceof HTMLElement) || !(shell instanceof HTMLElement)) return false;
      const inset = Number.parseFloat(getComputedStyle(viewport).paddingBottom);
      const contentBottom = viewport.getBoundingClientRect().bottom - inset;
      return inset > 0 && contentBottom <= shell.getBoundingClientRect().top + 1;
    }), { timeout: 10_000 }).toBe(true);

    // What the *command line* contributes to the count. `BROWSING-` appears
    // once in the echoed `printf` and never again — the output is
    // `BROWSING-01` — so any growth past this is output the session produced.
    // Counting rather than polling for a fixed index, because a fixed index
    // could already be on screen before the wheel and the wait would be vacuous.
    const echoed = await countInBuffer(page, 'BROWSING-');

    // Browse: a real wheel event, the same one a user produces.
    await wheelOverTerminal(page, -400);
    await expect
      .poll(async () => readScrollMode(page), { timeout: 5_000 })
      .toBe('history');
    await expect.poll(async () => page.locator('[data-terminal-viewport]').evaluate(el => Number.parseFloat(getComputedStyle(el).paddingBottom))).toBe(0);
    const parked = await readViewport(page);

    // Output arrives while the user is reading — from the session, with nothing
    // sent from here — and it must not drag the view down. The whole point of
    // local scrollback is that history stays where it was put.
    await expect
      .poll(async () => countInBuffer(page, 'BROWSING-'), { timeout: 20_000 })
      .toBeGreaterThan(echoed);
    // Only the view's own position — `baseY` is deliberately not compared.
    // The poll above waits for output to arrive, and *that event is a growth of
    // `baseY`*; requiring it unchanged alongside "output arrived" is the
    // contradiction that made this flake (#1261, whose recorded signature is
    // exactly this: `viewportY` fixed, `following: false`, `baseY` 170→171).
    // What the test is named for is that the *view* stays where it was put.
    const after = await readViewport(page);
    expect(
      after.viewportY,
      'the viewport moved under a reader: output while browsing must not scroll ' +
        'the view',
    ).toBe(parked.viewportY);
    // Compared rather than pinned to `false`, so the message reads as "unchanged
    // while output arrived" and not as a second, unrelated claim.
    expect(after.following, 'the view stopped being parked in history').toBe(
      parked.following,
    );
    expect(await readScrollMode(page)).toBe('history');

    // And the way back: at the real bottom the terminal follows again, and the
    // producer is still running so there is something to follow.
    await wheelOverTerminal(page, 4000);
    await expect
      .poll(async () => readScrollMode(page), { timeout: 5_000 })
      .toBe('following');
    await expect
      .poll(async () => (await readViewport(page)).following, { timeout: 15_000 })
      .toBe(true);
    await expect.poll(async () => page.locator('[data-terminal-viewport]').evaluate(el => Number.parseFloat(getComputedStyle(el).paddingBottom))).toBeGreaterThan(0);
  });

  test('the application, not tmux, owns the terminal the browser drives (#321 S3)', async ({ page }, testInfo) => {
    // Two claims with one cause. The attach transport decides what xterm
    // receives: tmux's own client rendering, or the pane's raw output. The
    // buffer type is the observable that separates them, and the wheel is what
    // the difference is *for* — #1096 criterion 7 and #321's scrollback goals
    // are both unreachable while tmux's client sits in between.
    //
    // Both assertions fail against `AttachMode::plain`, which is what makes
    // this a test about the transport rather than about the wheel: the shell
    // would be on the alternate screen, and the wheel would be consumed by tmux
    // instead of reaching the application.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-transport-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    // A shell asks for no alternate screen, so it is still on the normal
    // buffer — which is the buffer that has scrollback at all.
    expect(await readBufferType(page)).toBe('normal');

    await submitTerminalCommand(page, ptyProbeInstaller());
    await startPtyProbe(page, 'mouse-sgr');

    // The probe asked for mouse tracking, so `shouldScrollLocally()` must hand
    // the wheel to the application. What comes back is not `cat -v`'s doing:
    // the *tty driver* echoes the bytes it receives, rendering ESC as `^[`, so
    // an SGR report reads as `^[[<…`. No newline is needed — the same mechanism
    // the arrow-key test above relies on.
    await wheelOverTerminal(page, -120);
    await expect
      .poll(async () => countInBuffer(page, '^[[<'), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await stopPtyProbe(page);
  });

  test('capsule arrow follows the cursor mode the PTY asked for (#1096)', async ({ page }, testInfo) => {
    // The requirement's end-to-end claim, and the one thing every gate above
    // this line can only approximate: the same tap produces different bytes
    // because the *terminal* changed mode, not because the test changed a stub.
    //
    // Nothing here is typed on a physical keyboard. The key goes through the
    // capsule's own control, which is the App/mobile interaction path — the
    // criterion asks for that path specifically, and no spec had ever pressed
    // one of those keys.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    const SESSION_NAME = `e2e-cursor-mode-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, ptyProbeInstaller());

    // Normal cursor mode first: `cat -v` renders ESC [ A as `^[[A`.
    await startPtyProbe(page, 'normal');
    await tapCapsuleArrowUp(page);
    await expect(async () => {
      expect(await countInBuffer(page, '^[[A')).toBeGreaterThan(0);
      // The mode is the variable, so the other encoding must not have appeared.
      expect(await countInBuffer(page, '^[OA')).toBe(0);
    }).toPass({ timeout: 15_000 });
    await stopPtyProbe(page);

    // Same tap, application cursor mode: ESC O A, rendered `^[OA`. A constant
    // encoder passes the case above and fails this one.
    await startPtyProbe(page, 'appcursor');
    await tapCapsuleArrowUp(page);
    await expect(async () => {
      expect(await countInBuffer(page, '^[OA')).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await stopPtyProbe(page);
  });
});
