'use strict';
// Shared browser machinery for the #2879 Web Terminal lifecycle/memory Cases.
//
// Every Case drives `/fixture/clipboard`, which mounts the production
// `TerminalController`, ordered writer, xterm parser and capsule scroll over a
// harness transport. The helper only opens that fixture and feeds bounded
// output; lifecycle ownership, provider registrations and heap samples stay in
// the Case that claims them.
const { openClipboardFixture } = require('./terminal-clipboard-cases.cjs');

async function openLifecycleFixture(page, search = '') {
  await openClipboardFixture(page, search);
  await page.waitForFunction(() => Boolean(window.clipboardHarness?.lifecycle));
}

/**
 * Emit numbered lines in bounded chunks through the production writer.
 *
 * Each chunk is one transport frame; the next chunk is not emitted until the
 * chunk's last line is parsed, so the run never drives the writer into its
 * overflow bound by accident. A stalled stream fails naming the last parsed
 * line instead of silently measuring a short run.
 */
async function emitOrderedLines(page, { from, to, chunk = 20_000, prefix = 'B' }) {
  return page.evaluate(async ({ start, end, chunkLines, marker }) => {
    const harness = window.clipboardHarness;
    const liveTerminal = () => {
      const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visible && visible.parentElement && visible.parentElement.xtermInstance;
    };
    const tail = () => {
      const term = liveTerminal();
      if (!term) { return ''; }
      const buffer = term.buffer.active;
      // Newest non-empty line anywhere, not a fixed last-rows window: a short
      // chunk lands near the top of an otherwise empty screen.
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const text = (buffer.getLine(index)?.translateToString(true) ?? '').trim();
        if (text) { return text; }
      }
      return '';
    };
    const waitForTail = async (line) => {
      const deadline = performance.now() + 60_000;
      while (performance.now() < deadline) {
        if (tail() === marker + line) { return; }
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      throw new Error('output stalled before ' + marker + line + '; tail=' + tail());
    };
    const started = performance.now();
    for (let lineStart = start; lineStart <= end; lineStart += chunkLines) {
      const lineEnd = Math.min(end, lineStart + chunkLines - 1);
      let text = '';
      for (let line = lineStart; line <= lineEnd; line += 1) {
        text += marker + line + '\r\n';
      }
      harness.emit(text);
      await waitForTail(lineEnd);
    }
    return {
      elapsedMs: Math.round(performance.now() - started),
      lines: end - start + 1,
      tail: tail(),
    };
  }, { start: from, end: to, chunkLines: chunk, marker: prefix });
}

module.exports = { emitOrderedLines, openLifecycleFixture };
