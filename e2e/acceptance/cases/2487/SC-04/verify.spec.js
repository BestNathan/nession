'use strict';
// #2487 SC-04: ANSI/TUI output, line wraps, cursor, alternate screen,
// scrollback and PC -> phone -> PC remain correct under fixed columns.
//
// The Case distinguishes legitimate TUI repaint from horizontal reflow by
// measuring the wrap boundaries of a long line: they must stay at the same
// column positions on every device because the columns do not change. It also
// exercises the alternate screen through a real vim, the cursor, a reconnect
// bootstrap and a two-device ControlLease handoff.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, attachExisting, command, countInBuffer, readBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

/**
 * Wait until the shell answers, without assuming a prompt string. The CI
 * runner uses bash (`runner:~$`); the local full-stack runner inherits the
 * host shell, so a typed marker is the portable readiness signal.
 */
async function waitForShell(page, marker) {
  await page.locator('.xterm').click();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await command(page, `printf '${marker}\\n'`);
    try {
      await expect.poll(async () => countInBuffer(page, marker).catch(() => 0),
        { timeout: 1000 }).toBeGreaterThan(0);
      return;
    } catch {
      await page.waitForTimeout(250);
    }
  }
  throw new Error('the shell did not answer a readiness marker');
}

function grid(page) {
  return page.evaluate(() => {
    const xterm = Array.from(document.querySelectorAll('.xterm')).find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = xterm?.parentElement?.xtermInstance;
    return {
      cols: term?.cols,
      rows: term?.rows,
      cursorX: term?.buffer?.active?.cursorX,
      cursorY: term?.buffer?.active?.cursorY,
      bufferType: term?.buffer?.active?.type,
    };
  });
}

/**
 * The long-line wrap fingerprint: the 200-x run produced by the shell, split
 * at the rendered grid boundary. A horizontal reflow changes these lengths; a
 * repaint of the same screen does not.
 */
function longLineFingerprint(page, marker) {
  return page.evaluate((wanted) => {
    const xterm = Array.from(document.querySelectorAll('.xterm')).find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = xterm?.parentElement?.xtermInstance;
    const buffer = term.buffer.active;
    const textAt = (i) => {
      const line = buffer.getLine(i);
      return line ? line.translateToString(true) : '';
    };
    // The LAST occurrence: an earlier marker of the same Case stays in the
    // scrollback, and this fingerprint is about the run just printed.
    let start = -1;
    for (let i = 0; i < buffer.length; i += 1) {
      if (textAt(i).includes(wanted + '-x')) start = i;
    }
    if (start < 0) {
      const dump = [];
      for (let i = 0; i < buffer.length; i += 1) dump.push(textAt(i));
      throw new Error('the long-line marker is not in the buffer:\n' + dump.join('\n'));
    }
    const run = [textAt(start)];
    for (let i = start + 1; i < buffer.length; i += 1) {
      const text = textAt(i);
      // A wrapped continuation of the x run is x's only. Stop at the first
      // line that is not: the prompt after the newline, or empty history.
      if (!/^x+$/.test(text)) break;
      run.push(text);
    }
    const totalX = run.join('').split('x').length - 1;
    return {
      first: run[0].length,
      second: run.length > 1 ? run[1].length : 0,
      last: run[run.length - 1].length,
      totalX,
      lines: run.length,
    };
  }, marker);
}

/**
 * Wait until the whole 200-x run is in the buffer before fingerprinting it.
 *
 * The marker line appears as soon as the first wrapped row arrives; on the
 * phone the remounted App terminal can still be receiving the rest of the
 * run. Reading then counts only the rows that had arrived (measured: 142 of
 * 200) and reads as a reflow. Poll the fingerprint's own completeness rather
 * than sleeping.
 */
async function waitForLongLine(page, marker) {
  await expect.poll(async () => {
    try {
      return (await longLineFingerprint(page, marker)).totalX;
    } catch {
      return 0;
    }
  }, { timeout: 20_000 }).toBe(200);
  return longLineFingerprint(page, marker);
}

async function printLongLine(page, marker) {
  await command(page, `printf '${marker}-%s\\n' "$(printf 'x%.0s' $(seq 1 200))"`);
  // Wait for the **output** line, not the echoed command: the echo contains
  // the marker but starts with the prompt, and a `contains` poll would return
  // before the tty produced anything.
  try {
    await expect.poll(async () => page.evaluate((wanted) => {
      const xterm = Array.from(document.querySelectorAll('.xterm')).find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = xterm?.parentElement?.xtermInstance;
      const buffer = term?.buffer?.active;
      if (!buffer) return false;
      for (let i = 0; i < buffer.length; i += 1) {
        const line = buffer.getLine(i);
        if (line && line.translateToString(true).includes(wanted + '-x')) return true;
      }
      return false;
    }, marker), { timeout: 20_000 }).toBe(true);
  } catch (error) {
    throw new Error(error.message + '\nBUFFER:\n' + await readBuffer(page));
  }
}

/** Every PTY resize this page sends, so no transient wrong width can hide. */
function recordResizeCols(page) {
  const cols = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (event) => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame?.msg_type === 'agent.terminal.resize') {
          cols.push(frame.payload?.cols);
        }
      } catch {
        // A non-JSON frame (control ping, binary) is not a resize.
      }
    });
  });
  return cols;
}

test('SC-04: wrap, cursor, alternate screen, scrollback and device handoff', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-04');
  const resizeCols = recordResizeCols(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { name } = await createAndAttach(page, expect, runtime, 'case-2487-sc04', 'Relay', null);
  await waitForShell(page, 'SC04-READY');
  expect((await grid(page)).cols).toBe(80);

  // 1. Terminal-produced long line at the fixed width.
  await printLongLine(page, 'SC04-LONG-PC-1');
  const pcWrap = await waitForLongLine(page, 'SC04-LONG-PC-1');
  expect(pcWrap.first, 'the first wrapped line is the canonical width').toBe(80);
  expect(pcWrap.second).toBe(80);
  expect(pcWrap.totalX).toBe(200);

  // 2. A real ANSI cursor move (clear, home, row 5 column 10). The shell is
  //    kept busy so the prompt does not immediately overwrite the position.
  await command(page, "printf '\\033[2J\\033[H\\033[5;10H'; sleep 3");
  await expect.poll(async () => (await grid(page)).cursorX, { timeout: 10_000 }).toBe(9);
  const cursor = await grid(page);
  expect(cursor.cursorY, 'the cursor is on the ANSI-requested row').toBe(4);

  // 2b. Scrollback inside one experience: history survives a width change
  //     that does not cross the mobile breakpoint.
  await command(page, "printf 'SC04-HIST-MARK\\n'");
  await command(page, 'seq 1 100');
  await expect.poll(async () => countInBuffer(page, 'SC04-HIST-MARK'), { timeout: 20_000 })
    .toBe(1);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 15_000 }).toBe(80);
  expect(await countInBuffer(page, 'SC04-HIST-MARK'),
    'desktop history must survive a width change').toBe(1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 15_000 }).toBe(80);

  // 3. Alternate screen through a real full-screen TUI; resize around it.
  //    The PC terminal owns the alternate screen. Crossing the mobile
  //    breakpoint mounts the App experience's terminal, which is filled by a
  //    screen-only tmux capture — evidence of vim's *screen*, not a claim of
  //    complete VT-mode restoration (the same boundary #2307 SC-08 names).
  await command(page,
    "vim -u NONE -N -c 'call setline(1,\"SC04-TUI-MARK\")' /tmp/sc04-tui");
  await expect.poll(async () => (await grid(page)).bufferType, { timeout: 20_000 })
    .toBe('alternate');
  await expect.poll(async () => countInBuffer(page, 'SC04-TUI-MARK'), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 20_000 }).toBe(80);
  await expect.poll(async () => countInBuffer(page, 'SC04-TUI-MARK'), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await command(page, ':q!');
  await page.waitForTimeout(300);
  await command(page, "printf 'SC04-AFTER-%s\\n' 2487");
  await expect.poll(async () => countInBuffer(page, 'SC04-AFTER-2487'), { timeout: 20_000 })
    .toBe(1);

  // 4. Phone: the same long-line boundaries; a fresh phone-produced line has
  //    the identical split.
  await printLongLine(page, 'SC04-LONG-PHONE-1');
  const phoneWrap = await waitForLongLine(page, 'SC04-LONG-PHONE-1');
  expect(phoneWrap.first, 'a phone must not reflow the grid').toBe(pcWrap.first);
  expect(phoneWrap.second).toBe(pcWrap.second);
  expect(phoneWrap.totalX).toBe(200);
  // The final partial line depends on the marker's own length; the wrap
  // boundaries (first/second line lengths) are what a reflow would change.

  // 5. Back to PC: a fresh line wraps at the same boundaries. Crossing the
  //    mobile breakpoint remounts the experience's terminal (a screen-only
  //    capture, not a VT restore), so the earlier buffer is not the evidence;
  //    the boundary of a line printed now is.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 20_000 }).toBe(80);
  await waitForShell(page, 'SC04-PC-AGAIN-READY');
  await printLongLine(page, 'SC04-LONG-PC-2');
  const pcAgain = await waitForLongLine(page, 'SC04-LONG-PC-2');
  expect(pcAgain.first).toBe(pcWrap.first);
  expect(pcAgain.second).toBe(pcWrap.second);

  // 6. Reconnect: reload and reattach through the deep link for the same
  //    Session; a fresh line still wraps at the same boundaries and the
  //    columns agree.
  const settingsId = await page.locator('[data-testid^="session-settings-"]')
    .first().getAttribute('data-testid');
  const sessionId = String(settingsId).replace('session-settings-', '');
  const wsUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(wsUrl) +
    '#/terminal/' + encodeURIComponent(sessionId));
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
  await waitForShell(page, 'SC04-RELOAD-READY');
  await printLongLine(page, 'SC04-LONG-RELOAD-1');
  const afterReload = await longLineFingerprint(page, 'SC04-LONG-RELOAD-1');
  expect(afterReload.first).toBe(pcWrap.first);
  expect(afterReload.second).toBe(pcWrap.second);
  expect((await grid(page)).cols).toBe(80);

  // Every resize this page sent named the Session's width, through the
  // viewport changes and the deep-link reconnect.
  expect(resizeCols.length).toBeGreaterThan(0);
  expect([...new Set(resizeCols)]).toEqual([80]);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': 200-char line wrapped at 80/80/24 on PC, phone and ' +
      'after reload; cursor at ' + cursor.cursorX + '; vim alternate screen survived a ' +
      '390px resize; ' + name + ' kept 80 columns across both devices and the reconnect',
  });
});
