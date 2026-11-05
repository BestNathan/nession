'use strict';
// Shared browser machinery for the #2659 mobile touch-scroll Cases.
//
// `/fixture/clipboard` mounts the production TerminalController — including
// `CapsuleOcclusionScroll` and its touch listeners — over the real xterm
// parser, so a synthetic touch sequence exercises the shipped handler while
// the harness transport records every byte the PTY would receive.
const { openClipboardFixture } = require('./terminal-clipboard-cases.cjs');
const { terminalPoint } = require('./terminal-tools-browser.cjs');

async function openScrollFixture(page) {
  await openClipboardFixture(page);
}

/** The live xterm buffer, modes, cell metrics and screen centre. */
async function terminalView(page) {
  return page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = visible && visible.parentElement && visible.parentElement.xtermInstance;
    if (!term) throw new Error('no visible xterm instance');
    const screen = visible.querySelector('.xterm-screen') || visible;
    const rect = screen.getBoundingClientRect();
    return {
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
      length: term.buffer.active.length,
      type: term.buffer.active.type,
      rows: term.rows,
      cellHeight: rect.height / term.rows,
      mouseTrackingMode: term.modes.mouseTrackingMode,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    };
  });
}

/** Dispatch one `touchstart`/`touchmove`/`touchend` with the given points. */
async function dispatchTouch(page, type, points) {
  return page.evaluate(({ kind, touches }) => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!visible) throw new Error('no visible terminal');
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      // A real Touch carries page coordinates too; xterm's own viewport touch
      // handler reads `pageY`, and a touch object without it would drive that
      // path with NaN rather than with the gesture this Case describes.
      value: touches.map(([clientX, clientY]) => ({
        clientX,
        clientY,
        pageX: clientX + window.scrollX,
        pageY: clientY + window.scrollY,
      })),
    });
    visible.dispatchEvent(event);
    return event.defaultPrevented;
  }, { kind: type, touches: points });
}

/** Emit the scrollback a local-history Case needs; resolves at the live bottom. */
async function fillScrollback(page, lines = 120) {
  await page.evaluate((count) => {
    const output = Array.from({ length: count }, (_, index) => 'scroll line ' + index)
      .join('\r\n');
    window.clipboardHarness.emit(output + '\r\n');
  }, lines);
  await page.waitForFunction(() => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = visible && visible.parentElement && visible.parentElement.xtermInstance;
    return Boolean(term) && term.buffer.active.baseY > 0;
  }, undefined, { timeout: 10_000 });
  // Let the ordered writer settle at the live bottom.
  await page.waitForTimeout(150);
}

/**
 * Let the capsule's post-open follow reconciliation settle.
 *
 * `CapsuleOcclusionScroll` schedules `scrollToMarginBottom` on a double
 * `requestAnimationFrame` when a panel geometry change lands while following.
 * A drag started before those frames run can be undone by that follow, so
 * wait them out before measuring or dragging.
 */
async function settleTerminalFrames(page, frames = 4) {
  await page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

/**
 * One vertical finger drag over the real terminal.
 *
 * Positive `rows` moves the finger down (browses older output); negative moves
 * it up. Travel is several cells per requested row and is split across moves:
 * xterm's cell height is fractional and may change on a font/fit pass, so a
 * drag sized to exactly one cell can round to zero whole lines. Assertions use
 * the direction of travel, not the exact line count.
 */
async function dragTerminalRows(page, rows) {
  const view = await terminalView(page);
  const point = await terminalPoint(page);
  const travel = Math.max(32, Math.ceil(view.cellHeight * Math.abs(rows) * 3));
  const direction = rows > 0 ? 1 : -1;
  // Upward drags start lower so the whole gesture stays on the visible screen.
  const startY = direction > 0 ? point.y : point.y + 4 + travel;
  const moves = 5;
  await dispatchTouch(page, 'touchstart', [[point.x, startY]]);
  // The first 4px stays inside the axis slop, exactly like a real finger.
  await dispatchTouch(page, 'touchmove', [[point.x, startY + direction * 4]]);
  for (let index = 1; index <= moves; index += 1) {
    const y = startY + direction * (4 + Math.round((travel * index) / moves));
    await dispatchTouch(page, 'touchmove', [[point.x, y]]);
  }
  await dispatchTouch(page, 'touchend', []);
}

module.exports = {
  dispatchTouch, dragTerminalRows, fillScrollback, openScrollFixture,
  settleTerminalFrames, terminalView,
};
