'use strict';
// Shared browser machinery for the #2659 mobile touch-scroll Cases.
//
// `/fixture/clipboard` mounts the production TerminalController — including
// `CapsuleOcclusionScroll` and its touch listeners — over the real xterm
// parser, so a synthetic touch sequence exercises the shipped handler while
// the harness transport records every byte the PTY would receive.
const { openClipboardFixture } = require('./terminal-clipboard-cases.cjs');

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

module.exports = { dispatchTouch, fillScrollback, openScrollFixture, terminalView };
