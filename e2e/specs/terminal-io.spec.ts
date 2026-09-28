import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForShell } from '../helpers/shell';

// __dirname (not import.meta): Playwright transforms specs to CJS — this
// package.json is not "type": "module". Same convention as
// e2e/helpers/ui-assert/contracts.ts, which loads the design contracts.
declare const __dirname: string;

/**
 * Read the xterm buffer text via the `xtermInstance` property exposed on the
 * container element by TerminalInstance.attach().  Canvas/webgl renderers
 * don't put text in the DOM, so this is the reliable way to assert on
 * terminal output.
 */
async function readTerminalBuffer(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const xtermEl = document.querySelector('.xterm');
    const container = xtermEl?.parentElement;
    // xtermInstance is set by TerminalInstance.attach()
    const term = (container as Record<string, unknown>)?.xtermInstance as
      | { buffer: { active: { length: number; getLine(y: number): { translateToString(): string } | undefined } } }
      | undefined;
    if (!term) {return '';}
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {lines.push(line.translateToString());}
    }
    return lines.join('\n');
  });
}

/**
 * xterm's own grid — what the *browser* thinks the terminal is.
 *
 * That is not the same question as what the application thinks, which is the
 * whole of #1187: the grid can resize while the Session's tty does not, and
 * only `stty size` inside the Session answers the second one.
 */
async function readGrid(
  page: import('@playwright/test').Page,
): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const xtermEl = document.querySelector('.xterm');
    const term = (xtermEl?.parentElement as { xtermInstance?: { cols: number; rows: number } } | null)
      ?.xtermInstance;
    if (!term) {
      throw new Error('xtermInstance not mounted');
    }
    return { cols: term.cols, rows: term.rows };
  });
}

/**
 * Wait until the grid has stopped moving.
 *
 * xterm opens at its own default and is resized afterwards by a
 * ResizeObserver, so the size read straight after attach describes the layout
 * only once that has settled. Two consecutive reads that agree is the
 * condition; nothing here assumes what the answer should be.
 */
async function waitForStableGrid(page: import('@playwright/test').Page): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const { cols, rows } = await readGrid(page);
        const current = `${cols}x${rows}`;
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBe(true);
}

/** Wait for the xterm terminal to be mounted and ready. */
async function waitForTerminal(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.xterm').waitFor({ state: 'visible', timeout: 15_000 });
  // Wait until the xtermInstance property is set (terminal instance is mounted)
  await expect(async () => {
    const text = await readTerminalBuffer(page);
    // Buffer exists even if empty — we just need xtermInstance to be set
    expect(text).toBeDefined();
  }).toPass({ timeout: 5_000 });
}

/**
 * Wait until the Sessions list is actionable.
 *
 * The sidebar is a column above `lg` and the open drawer below it, so it is
 * always present and there is nothing to open first — the header's drawer
 * opener went with the header (#748).
 */
async function ensureSessionsList(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByTestId('create-session')).toBeVisible({ timeout: 10_000 });
}

/** Create a session via the UI and return its name. */
async function createSession(page: import('@playwright/test').Page, name: string): Promise<void> {
  await ensureSessionsList(page);
  const createButton = page.getByTestId('create-session');
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();

  // Named, not the bare role locator (#1082): creating makes the new Session
  // current, which runs the ordinary selection path — attach included — so a
  // second dialog is on screen by the time this line runs.
  const createDialog = page.getByRole('dialog').filter({ hasText: 'Create Session' });
  await expect(createDialog).not.toBeVisible({ timeout: 10_000 });

  // This helper's contract is "the Session exists in the list". Selecting it is
  // what #1082 added and the attach flow is a consequence of that selection, so
  // dismiss it and leave the caller to attach the way it wants to — otherwise
  // the modal it opened intercepts the row click `attachToSession` makes next.
  const attachDialog = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(attachDialog).toBeVisible({ timeout: 10_000 });
  await attachDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(attachDialog).not.toBeVisible({ timeout: 5_000 });

  // Wait for session to appear in the shell list
  await expect(page.locator('[data-testid="session-item-row"]', { hasText: name })).toBeVisible({ timeout: 10_000 });
}

/** Attach to a session via the UI, selecting the specified mode. */
async function attachToSession(
  page: import('@playwright/test').Page,
  sessionName: string,
  mode: 'Auto' | 'P2P' | 'Relay',
): Promise<void> {
  // Find the session row and click it — the shell list selects a
  // session by opening AttachDialog pre-seeded with that session.
  await ensureSessionsList(page);
  const row = page.locator('[data-testid="session-item-row"]', { hasText: sessionName });
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click();

  // AttachDialog opens
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Select the desired mode. The ModeToggle renders three buttons whose
  // accessible names include both the mode label AND the hint (e.g.
  // "Relay Proxy through server (works behind NAT/firewalls)"). A plain
  // { name: 'Relay' } substring match therefore picks up the Auto buttons
  // too (their hint text happens to contain the search string). Anchoring
  // at the start with a regex restricts matches to the mode whose label
  // actually begins with the name we want.
  await dialog.getByRole('button', { name: new RegExp(`^${mode}\\b`) }).click();

  // Wait for the Attach button to be enabled (attachInfo loaded)
  const attachButton = dialog.getByRole('button', { name: 'Attach' });
  await expect(attachButton).toBeEnabled({ timeout: 10_000 });
  await attachButton.click();

  // Dialog closes and terminal view loads
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
}

/**
 * Wait until the session is attached and the shell prompt is stable.
 *
 * P2P attach can rewire the transport once the live agent-terminal API swaps
 * (#668). Playwright keyboard events during that window produce duplicated
 * bytes and stray CSI in the PTY — wait for `terminal-connecting` to clear and
 * for the scrollback to stop changing before sending input.
 */
async function waitForInteractiveShell(page: import('@playwright/test').Page): Promise<void> {
  await waitForTerminal(page);
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-loading')).toBeHidden({ timeout: 30_000 });
  const shellPrompt = /runner:\S*\$/m;
  await expect(async () => {
    const text = await readTerminalBuffer(page);
    expect(text).toMatch(shellPrompt);
  }).toPass({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const first = await readTerminalBuffer(page);
        await page.waitForTimeout(250);
        const second = await readTerminalBuffer(page);
        return first === second && shellPrompt.test(second);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Send raw bytes through xterm's input API — the same path as the keyboard. */
async function sendRawToTerminal(page: import('@playwright/test').Page, data: string): Promise<void> {
  await page.evaluate((bytes) => {
    const xtermEl = document.querySelector('.xterm');
    const container = xtermEl?.parentElement as
      | ({ xtermInstance?: { input(data: string, wasUserInput: boolean): void } } & Record<string, unknown>)
      | null;
    const term = container?.xtermInstance;
    if (!term) {
      throw new Error('xtermInstance not mounted');
    }
    term.input(bytes, true);
  }, data);
}

/** Commit a shell command through xterm's input API (same path as keyboard). */
async function submitTerminalCommand(page: import('@playwright/test').Page, command: string): Promise<void> {
  await sendRawToTerminal(page, `${command}\n`);
}

/**
 * Ask the Session for its tty size, re-asking until it reports `cols`×`rows`.
 *
 * Re-asking is the whole point, and #1187 is what it cost to learn. The Web
 * resizes the local xterm grid in the same frame as the container change but
 * *debounces* the PTY notification by 200 ms (`ResizeController`, so a drag
 * sends one final size) — so for a moment after a viewport change the grid is
 * new and the PTY is still old. `stty size` is a one-shot observation: a single
 * submission taken inside that window prints the old size and never prints
 * anything else, so polling the scrollback afterwards waits out the full
 * timeout for a number that will not be re-emitted. That is exactly how #1187
 * was first read as "the resize never reaches the PTY" on CI while the same
 * probe passed locally, where it happened to be taken after the debounce.
 *
 * Re-submitting makes the assertion a question about the Session rather than
 * about when the question was asked. A PTY that genuinely never follows still
 * fails: the answer never changes, however often it is asked.
 */
async function expectPtySize(
  page: import('@playwright/test').Page,
  cols: number,
  rows: number,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await submitTerminalCommand(page, 'stty size');
        return readTerminalBuffer(page);
      },
      { timeout, intervals: [1_000] },
    )
    .toContain(`${rows} ${cols}`);
}

/** How many times `needle` occurs in the scrollback. */
async function countInBuffer(page: import('@playwright/test').Page, needle: string): Promise<number> {
  const text = await readTerminalBuffer(page);
  return text.split(needle).length - 1;
}

/**
 * Put `pty-probe.sh` into the Session's working directory.
 *
 * The PTY's cwd is `/tmp/nession-e2e`, not the checkout, so the committed
 * script cannot be run by path. Base64 keeps the install to one line with
 * nothing for the shell to re-interpret, and keeps the committed script the
 * only copy of itself — an inlined copy here would drift from it silently.
 */
function ptyProbeInstaller(): string {
  const script = readFileSync(join(__dirname, '..', 'fixtures', 'pty-probe.sh'), 'utf8');
  return `printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > pty-probe.sh`;
}

/** Start the probe in `mode` and wait until it has set it. */
async function startPtyProbe(page: import('@playwright/test').Page, mode: string): Promise<void> {
  await submitTerminalCommand(page, `sh pty-probe.sh ${mode}`);
  await expect(async () => {
    expect(await readTerminalBuffer(page)).toContain(`PTY-PROBE READY ${mode}`);
  }).toPass({ timeout: 15_000 });
}

/** End the probe: Ctrl-C kills `cat -v` and returns the shell prompt. */
async function stopPtyProbe(page: import('@playwright/test').Page): Promise<void> {
  await sendRawToTerminal(page, '\x03');
  await expect
    .poll(async () => /runner:\S*\$/m.test(await readTerminalBuffer(page)), { timeout: 15_000 })
    .toBe(true);
}

/** The last line with anything on it — where a terminal's cursor actually is. */
async function lastNonEmptyLine(page: import('@playwright/test').Page): Promise<string> {
  const text = await readTerminalBuffer(page);
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? '';
}

/** Tap the capsule's ↑ — the App/mobile key path, not a keyboard event. */
async function tapCapsuleArrowUp(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('capsule-capability-more').click();
  await page.getByTestId('capsule-capability-picker-terminal-keys').click();
  await page.getByTestId('phys-key-↑').click();
}

// NOTE: these tests are CI-gated per repo convention (the fixture specs use
// the same `test.skip(!process.env.CI, ...)` pattern): they drive a real
// tmux-backed agent, which the e2e webServer stack only provides in CI. The
// historical blocker ("terminal does not support clear" at tmux session
// creation) is stale — the agent forces TERM=xterm-256color when creating
// sessions. A failure here in CI is a genuine regression: investigate it,
// don't re-skip the test.
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

  test('a curses TUI renders and gives the shell back (#1096)', async ({ page }, testInfo) => {
    // Criterion 15's curses smoke. Nothing here is Nession-specific, and that
    // is the point: `less` reads keys in raw mode, paints its own screen from
    // terminfo, and exits on a keystroke. The fixtures in this file drive the
    // PTY with escapes the test itself wrote; this drives it with a program
    // that was written without Nession in mind.
    //
    // It deliberately does not assert on the alternate screen. That is not
    // observable from the browser: tmux owns its client's screen and mouse
    // mode — `pty.rs` sets only `status off`, and tmux turns both on itself —
    // so `buffer.active.type` reads `'alternate'` for a plain shell too.
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
    // nothing, while the probe keeps running in the pane. Counting before and
    // after rather than asserting presence, because the reattach re-bootstraps
    // the scrollback and the earlier `^[OA` comes back with it.
    await page.reload();
    await waitForTerminal(page);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    const before = await countInBuffer(page, '^[OA');
    await tapCapsuleArrowUp(page);
    await expect(async () => {
      expect(await countInBuffer(page, '^[OA')).toBeGreaterThan(before);
    }).toPass({ timeout: 15_000 });
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
