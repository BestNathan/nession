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
 * Which screen xterm is drawing to — `normal` or `alternate`.
 *
 * This is the one observable that separates the two attach transports, because
 * it is the one tmux's *client* decides rather than the application. Under
 * `AttachMode::plain` the client enters the alternate screen unconditionally
 * (measured on 3.6b), so a plain shell sits on `alternate` and has no
 * scrollback; under `control` the pane's own bytes arrive, a shell never asks
 * for the alternate screen, and the same shell sits on `normal`. A test that
 * asserts this is therefore a test about which transport the browser is on.
 */
async function readBufferType(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const xtermEl = document.querySelector('.xterm');
    const term = (xtermEl?.parentElement as { xtermInstance?: { buffer: { active: { type: string } } } } | null)
      ?.xtermInstance;
    if (!term) {
      throw new Error('xtermInstance not mounted');
    }
    return term.buffer.active.type;
  });
}

/**
 * Put the pointer over the terminal grid and roll the wheel there.
 *
 * A real wheel event, not a synthesised xterm call: whether it scrolls locally
 * or reaches the application is decided by `occlusionScroll`'s wheel handler,
 * which only runs for an event that arrives the way a user's does.
 */
async function wheelOverTerminal(page: import('@playwright/test').Page, deltaY: number): Promise<void> {
  const box = await page.locator('.xterm-screen').boundingBox();
  if (!box) {
    throw new Error('the terminal grid has no box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/**
 * The scroll mode the capsule is in — `following` or `history`.
 *
 * `occlusionScroll.setMode` writes it as a data attribute on the capsule host,
 * and it is the state the capsule's bottom inset and every follow decision are
 * keyed on. Read from the DOM rather than through a test hook because that
 * attribute *is* the product's signal: the same one CSS keys on.
 */
async function readScrollMode(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    return (host as HTMLElement | null)?.dataset.terminalScrollMode ?? 'none';
  });
}

/**
 * Where the viewport is: `viewportY` from the top of the scrollback, `baseY` at
 * the bottom, and whether those are the same.
 *
 * `baseY` is the **bottom of the scrollback, not part of the view**: it grows
 * every time the session produces a line, whether or not anything moved. A
 * "did the view move" assertion therefore needs `viewportY` (the view's own
 * position) and `following` — pinning `baseY` too asks for "output arrived" and
 * "the buffer did not grow" at once, which is #1261.
 *
 * If you do compare the whole object, `toStrictEqual` rather than `toBe`: this
 * builds a fresh object each call, so identity comparison fails on two equal
 * readings and reports it as "serializes to the same string" — which is how the
 * first version of the assertion below failed three times on a product that was
 * behaving.
 */
async function readViewport(
  page: import('@playwright/test').Page,
): Promise<{ viewportY: number; baseY: number; following: boolean }> {
  return page.evaluate(() => {
    const term = (document.querySelector('.xterm')?.parentElement as
      | { xtermInstance?: { buffer: { active: { viewportY: number; baseY: number } } } }
      | null)?.xtermInstance;
    if (!term) {
      throw new Error('xtermInstance not mounted');
    }
    const { viewportY, baseY } = term.buffer.active;
    return { viewportY, baseY, following: viewportY === baseY };
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
test.describe('Attach bootstrap (#321)', () => {
  // Two browser *contexts*, not two pages: the WebSocket service is a
  // per-storage singleton, so two pages in one context share one connection and
  // one terminal runtime — a second client has to be a second context.
  //
  // The claim under test is the one thing a bootstrap exists for and the one
  // thing live output cannot fake: a client that just attached is shown history
  // that was produced **before** it connected, while the other client sits idle
  // and this one sends nothing.

  const APP_URL =
    '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws');

  /** A marker whose typed form and rendered form differ. */
  const typedForm = (tag: string) => `printf 'BOOT-%s\\n' ${tag}`;
  const renderedForm = (tag: string) => `BOOT-${tag}`;

  test('a second client is shown history it never received live', async ({ page, browser }, testInfo) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto(APP_URL);
    await waitForShell(page);

    const SESSION_NAME = `e2e-bootstrap-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    // The marker is printed by the *session*, before the second client exists.
    // Counting `BOOT-a1` and not the command line: the typed form is
    // `printf 'BOOT-%s\n' a1`, so `BOOT-a1` can only be output.
    await submitTerminalCommand(page, typedForm('a1'));
    await expect
      .poll(async () => countInBuffer(page, renderedForm('a1')), { timeout: 15_000 })
      .toBe(1);

    // A second client, with its own storage and its own connection.
    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(APP_URL);
      await waitForShell(other);
      await attachToSession(other, SESSION_NAME, 'Relay');
      await waitForInteractiveShell(other);

      // Nobody sends anything from here on. The only carrier of `BOOT-a1` to
      // this client is the bootstrap.
      //
      // Counted as exactly one as well as non-zero: the bootstrap *replaced*
      // this client's buffer rather than appending to it, so a duplicate here
      // would mean the marker arrived twice.
      await expect
        .poll(async () => countInBuffer(other, renderedForm('a1')), { timeout: 20_000 })
        .toBe(1);

      // Live output still flows to both. Printed now, so this marker can only
      // reach the second client through the stream.
      await submitTerminalCommand(page, typedForm('a2'));
      await expect
        .poll(async () => countInBuffer(other, renderedForm('a2')), { timeout: 15_000 })
        .toBe(1);

      // And the history did not come back with it: a live frame appends, and
      // the bootstrap that carried `a1` is not re-sent for one.
      expect(await countInBuffer(other, renderedForm('a1'))).toBe(1);

      // The whole thing survives the second client rebuilding its terminal.
      // This is the case the client answers `needs_bootstrap` for: the xterm is
      // new and holds nothing, so it asks, and what it gets is the session's
      // history — both markers, once each.
      await other.reload();
      await waitForShell(other);
      await waitForInteractiveShell(other);
      await expect
        .poll(async () => countInBuffer(other, renderedForm('a1')), { timeout: 20_000 })
        .toBe(1);
      expect(await countInBuffer(other, renderedForm('a2'))).toBe(1);
    } finally {
      await second.close();
    }
  });

  test('a client attaching mid-stream has no gap and no repeat at the boundary', async ({ page, browser }, testInfo) => {
    // The barrier's own test, and the one the plan called flagship. Everything
    // else asserts that the history *arrives*; this asserts that it *joins*.
    //
    // The producer numbers every line, so the two ways a join can be wrong are
    // both visible in one reading: a **missing** index is a gap at the boundary
    // (live output the snapshot did not include, and the forwarder started
    // after), and a **repeated** index is the opposite failure (the snapshot
    // overlapping output already delivered — #1148's class).
    //
    // Asserted as a set equality rather than "the last line is there": a client
    // that received lines 1..3 and 9..99 passes the latter.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto(APP_URL);
    await waitForShell(page);

    const SESSION_NAME = `e2e-gap-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    // Slowed deliberately: the second client has to attach *while* this is
    // still producing, or there is no boundary to be wrong about. ~6s of output
    // with the attach landing a second or two in.
    const TOTAL = 60;
    await submitTerminalCommand(
      page,
      `for i in $(seq 1 ${TOTAL}); do printf 'GAP-%03d\\n' $i; sleep 0.1; done`,
    );

    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(APP_URL);
      await waitForShell(other);
      await attachToSession(other, SESSION_NAME, 'Relay');
      await waitForInteractiveShell(other);

      // Wait for the producer to finish, so what is asserted is the whole range
      // rather than a prefix of it.
      await expect
        .poll(async () => countInBuffer(other, `GAP-${String(TOTAL).padStart(3, '0')}`), {
          timeout: 30_000,
        })
        .toBe(1);

      const text = await readTerminalBuffer(other);
      const indices = [...text.matchAll(/GAP-(\d{3})/g)].map((m) => Number(m[1]));

      expect(
        [...indices].sort((a, b) => a - b),
        `the second client's indices are not 1..${TOTAL} each exactly once — a ` +
          `missing one is a gap at the attach boundary, a duplicate is the ` +
          `snapshot overlapping the live stream`,
      ).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    } finally {
      await second.close();
    }
  });

  test("a bootstrap is that session's history and not another session's", async ({ page, browser }, testInfo) => {
    // The negative control. Without it, "the second client sees `BOOT-a1`"
    // would also pass if the marker reached it some other way — a shared
    // buffer, a cached response, a client that never cleared what it had.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto(APP_URL);
    await waitForShell(page);

    const WITH_MARKER = `e2e-bootstrap-a-${testInfo.retry}`;
    const WITHOUT = `e2e-bootstrap-b-${testInfo.retry}`;
    // Both created before either is attached. Creating a Session while this
    // client is attached to another one leaves the create dialog on screen —
    // measured: `Create` is clicked, the dialog never closes, and the helper
    // times out waiting for it. Nothing here needs the second Session to be
    // made later, so it is made first.
    await createSession(page, WITH_MARKER);
    await createSession(page, WITHOUT);

    await attachToSession(page, WITH_MARKER, 'Relay');
    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, typedForm('a1'));
    await expect
      .poll(async () => countInBuffer(page, renderedForm('a1')), { timeout: 15_000 })
      .toBe(1);

    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(APP_URL);
      await waitForShell(other);
      await attachToSession(other, WITHOUT, 'Relay');
      await waitForInteractiveShell(other);
      expect(await countInBuffer(other, renderedForm('a1'))).toBe(0);
    } finally {
      await second.close();
    }
  });
});

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
