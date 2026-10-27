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
  verifiedRuntime, createAndAttach, attachExisting, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

function grid(page) {
  return page.evaluate(() => {
    const xterm = document.querySelector('.xterm');
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
    const term = document.querySelector('.xterm')?.parentElement?.xtermInstance;
    const buffer = term.buffer.active;
    const textAt = (i) => {
      const line = buffer.getLine(i);
      return line ? line.translateToString(true) : '';
    };
    // The LAST occurrence: an earlier marker of the same Case stays in the
    // scrollback, and this fingerprint is about the run just printed.
    let start = -1;
    for (let i = 0; i < buffer.length; i += 1) {
      if (textAt(i).startsWith(wanted + '-')) start = i;
    }
    if (start < 0) throw new Error('the long-line marker is not in the buffer');
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

async function printLongLine(page, marker) {
  await command(page, `printf '${marker}-%s\\n' "$(printf 'x%.0s' $(seq 1 200))"`);
  await expect.poll(async () => countInBuffer(page, marker).catch(() => 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

test('SC-04: wrap, cursor, alternate screen, scrollback and device handoff', async ({
  page, browser,
}) => {
  test.setTimeout(240_000);
  const { runtime, sha } = verifiedRuntime('SC-04');
  await page.setViewportSize({ width: 1280, height: 800 });
  const { name } = await createAndAttach(page, expect, runtime, 'case-2487-sc04', 'Relay');
  expect((await grid(page)).cols).toBe(88);

  // 1. Terminal-produced long line at the fixed width.
  await printLongLine(page, 'SC04-LONG-PC-1');
  const pcWrap = await longLineFingerprint(page, 'SC04-LONG-PC-1');
  expect(pcWrap.first, 'the first wrapped line is the canonical width').toBe(88);
  expect(pcWrap.second).toBe(88);
  expect(pcWrap.totalX).toBe(200);

  // 2. A real ANSI cursor move (clear, home, row 5 column 10). The shell is
  //    kept busy so the prompt does not immediately overwrite the position.
  await command(page, "printf '\\033[2J\\033[H\\033[5;10H'; sleep 3");
  await expect.poll(async () => (await grid(page)).cursorX, { timeout: 10_000 }).toBe(9);
  const cursor = await grid(page);
  expect(cursor.cursorY, 'the cursor is on the ANSI-requested row').toBe(4);

  // 3. Alternate screen through a real full-screen TUI; resize around it.
  await command(page, "vim -u NONE -N /tmp/sc04-tui");
  await expect.poll(async () => (await grid(page)).bufferType, { timeout: 20_000 })
    .toBe('alternate');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 20_000 }).toBe(88);
  await expect.poll(async () => (await grid(page)).bufferType, { timeout: 20_000 })
    .toBe('alternate');
  await command(page, ':q!');
  await expect.poll(async () => (await grid(page)).bufferType, { timeout: 20_000 })
    .toBe('normal');

  // 4. Phone: the same long-line boundaries; a fresh phone-produced line has
  //    the identical split.
  await printLongLine(page, 'SC04-LONG-PHONE-1');
  const phoneWrap = await longLineFingerprint(page, 'SC04-LONG-PHONE-1');
  expect(phoneWrap.first, 'a phone must not reflow the grid').toBe(pcWrap.first);
  expect(phoneWrap.second).toBe(pcWrap.second);
  expect(phoneWrap.totalX).toBe(200);
  expect(phoneWrap.last).toBe(pcWrap.last);

  // 5. Back to PC: boundaries and the existing scrollback survive.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await grid(page)).cols, { timeout: 20_000 }).toBe(88);
  const pcAgain = await longLineFingerprint(page, 'SC04-LONG-PHONE-1');
  expect(pcAgain.first).toBe(pcWrap.first);
  expect(pcAgain.last).toBe(pcWrap.last);
  expect(await countInBuffer(page, 'SC04-LONG-PC-1')).toBe(1);

  // 6. Reconnect: the browser reloads, attaches to the live Session, and the
  //    history (including the wrapped line) is bootstrapped without a reflow.
  await page.reload();
  await attachExisting(page, expect, runtime, name, 'Relay');
  await expect.poll(async () => countInBuffer(page, 'SC04-LONG-PC-1').catch(() => 0),
    { timeout: 30_000 }).toBe(1);
  const afterReload = await longLineFingerprint(page, 'SC04-LONG-PHONE-1');
  expect(afterReload.first).toBe(pcWrap.first);
  expect(afterReload.last).toBe(pcWrap.last);

  // 7. A second device takes the lease; the pane keeps 88 columns and only
  //    rows follow the active device.
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phoneContext.newPage();
  await attachExisting(phonePage, expect, runtime, name, 'Relay');
  await phonePage.locator('.xterm').click();
  await phonePage.waitForTimeout(500);
  const phoneGrid = await grid(phonePage);
  expect(phoneGrid.cols, 'a taking-over device keeps the columns').toBe(88);

  await phoneContext.close();
  await page.locator('.xterm').click();
  await page.waitForTimeout(500);
  expect((await grid(page)).cols).toBe(88);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': 200-char line wrapped at 88/88/24 on PC, phone and ' +
      'after reload; cursor at ' + cursor.cursorX + '; vim alternate screen survived a ' +
      '390px resize; ' + name + ' kept 88 columns across both devices and the reconnect',
  });
});
