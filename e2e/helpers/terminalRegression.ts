import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCapsuleCapability } from './capsule';
import { waitForShell } from './shell';
import { E2E_TMUX_SOCKET } from '../runtime';

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
export async function readTerminalBuffer(page: import('@playwright/test').Page): Promise<string> {
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
export async function readBufferType(page: import('@playwright/test').Page): Promise<string> {
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
export async function wheelOverTerminal(page: import('@playwright/test').Page, deltaY: number): Promise<void> {
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
export async function readScrollMode(page: import('@playwright/test').Page): Promise<string> {
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
export async function readViewport(
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
export async function readGrid(
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
export async function waitForStableGrid(page: import('@playwright/test').Page): Promise<void> {
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
export async function waitForTerminal(page: import('@playwright/test').Page): Promise<void> {
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
export async function ensureSessionsList(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByTestId('create-session')).toBeVisible({ timeout: 10_000 });
}

/** Create a session via the UI and return its name. */
export async function createSession(page: import('@playwright/test').Page, name: string): Promise<void> {
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
export async function attachToSession(
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
export async function waitForInteractiveShell(page: import('@playwright/test').Page): Promise<void> {
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
export async function sendRawToTerminal(page: import('@playwright/test').Page, data: string): Promise<void> {
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
export async function submitTerminalCommand(page: import('@playwright/test').Page, command: string): Promise<void> {
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
export async function expectPtySize(
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
export async function countInBuffer(page: import('@playwright/test').Page, needle: string): Promise<number> {
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
export function ptyProbeInstaller(): string {
  const script = readFileSync(join(__dirname, '..', 'fixtures', 'pty-probe.sh'), 'utf8');
  return `printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > pty-probe.sh`;
}

/** Start the probe in `mode` and wait until it has set it. */
export async function startPtyProbe(page: import('@playwright/test').Page, mode: string): Promise<void> {
  await submitTerminalCommand(page, `sh pty-probe.sh ${mode}`);
  await expect(async () => {
    expect(await readTerminalBuffer(page)).toContain(`PTY-PROBE READY ${mode}`);
  }).toPass({ timeout: 15_000 });
}

/** End the probe: Ctrl-C kills `cat -v` and returns the shell prompt. */
export async function stopPtyProbe(page: import('@playwright/test').Page): Promise<void> {
  await sendRawToTerminal(page, '\x03');
  await expect
    .poll(async () => /runner:\S*\$/m.test(await readTerminalBuffer(page)), { timeout: 15_000 })
    .toBe(true);
}

/**
 * The Session's own pane, straight from tmux — the source side of the history
 * the browser is showing.
 *
 * `-S` is not optional and not a formality: nession never uses tmux's default
 * socket, and this run's is its own (`E2E_TMUX_SOCKET`).
 *
 * The target is `=<name>:` — the `=` is an exact-name match rather than a
 * prefix one (so `e2e-history-1` can never be read as `e2e-history-10`), and
 * the trailing colon is what makes it a **session** target. Without it tmux
 * reads `=name` as a pane name and answers `can't find pane: =name`, which is
 * measured, not assumed.
 *
 * `-S -` captures from the top of the saved history, so this is every line the
 * pane holds, not just the visible screen.
 */
export function readPane(sessionName: string): { text: string; sha: string; markers: number } {
  const text = execFileSync(
    'tmux',
    ['-S', E2E_TMUX_SOCKET, 'capture-pane', '-p', '-t', `=${sessionName}:`, '-S', '-'],
    { encoding: 'utf8' },
  );
  return {
    text,
    sha: createHash('sha256').update(text).digest('hex'),
    markers: text.split('\n').filter((line) => line.includes('REPAINT-')).length,
  };
}

/**
 * Put the repainting inline fixture into the Session's working directory.
 *
 * Same shape as `ptyProbeInstaller` and for the same reason: the PTY's cwd is
 * `/tmp/nession-e2e`, not the checkout, and base64 keeps the committed script
 * the only copy of itself.
 */
export function repaintFixtureInstaller(): string {
  const script = readFileSync(join(__dirname, '..', 'fixtures', 'inline-repaint.sh'), 'utf8');
  return `printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > inline-repaint.sh`;
}

/** The last line with anything on it — where a terminal's cursor actually is. */
export async function lastNonEmptyLine(page: import('@playwright/test').Page): Promise<string> {
  const text = await readTerminalBuffer(page);
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? '';
}

/**
 * Tap the capsule's ↑ — the capsule's own control, not a keyboard event.
 *
 * The key is what this drives: `phys-key-↑` inside the Terminal Keys Peek. How
 * the Peek is *reached* is the experience's business — the sensed row on App
 * (#1347 SC-37), the ordinary entry on the default Web viewport these specs run
 * at — so the opening step is the shared helper rather than a hardcoded row.
 * #1440 hardcoded the App row here and timed out on Web.
 */
export async function tapCapsuleArrowUp(page: import('@playwright/test').Page): Promise<void> {
  await openCapsuleCapability(page, 'terminal-keys');
  await page.getByTestId('phys-key-↑').click();
}

// NOTE: these tests are CI-gated per repo convention (the fixture specs use
// the same `test.skip(!process.env.CI, ...)` pattern): they drive a real
// tmux-backed agent, which the e2e webServer stack only provides in CI. The
// historical blocker ("terminal does not support clear" at tmux session
// creation) is stale — the agent forces TERM=xterm-256color when creating
// sessions. A failure here in CI is a genuine regression: investigate it,
// don't re-skip the test.
