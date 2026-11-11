'use strict';
// #2879 SC-05: the existing terminal-consistency-faults and terminal-io
// regressions remain the E2E evidence for ordering, parser-applied facts,
// overflow bootstrap repair, desktop/App reattach and history preservation.
// This Case independently proves those same invariants on the fixture surface
// after the lifecycle fixes, in both Web and App experiences.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { emitOrderedLines, openLifecycleFixture } = require('../../../shared/terminal-memory-lifecycle-cases.cjs');

const BURST_LINES = 20_000;
const HISTORY_LINES = 500;

async function exerciseTerminal(page, { prefix, historyMarker }) {
  // 1) Every numbered line is applied exactly once: no hole and no duplicate.
  await emitOrderedLines(page, {
    from: 1, to: BURST_LINES, chunk: BURST_LINES, prefix,
  });
  const ordering = await page.evaluate(({ marker }) => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const terminal = visible && visible.parentElement && visible.parentElement.xtermInstance;
    if (!terminal) { throw new Error('no visible terminal'); }
    const buffer = terminal.buffer.active;
    const pattern = new RegExp('^' + marker + '(\\d+)$');
    const numbers = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const text = (buffer.getLine(index)?.translateToString(true) ?? '').trim();
      const match = pattern.exec(text);
      if (match) { numbers.push(Number(match[1])); }
    }
    return {
      count: numbers.length,
      unique: new Set(numbers).size,
      first: numbers[0],
      last: numbers.at(-1),
      contiguous: numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1),
    };
  }, { marker: prefix });
  expect(ordering.count).toBe(BURST_LINES);
  expect(ordering.unique).toBe(BURST_LINES);
  expect(ordering.contiguous).toBe(true);
  expect(ordering.first).toBe(1);
  expect(ordering.last).toBe(BURST_LINES);

  // 2) A real writer overflow rebuilds the renderer; the bootstrap capture
  //    that follows is parsed into the replacement buffer.
  const repaired = await page.evaluate(async () => {
    const lifecycle = window.clipboardHarness.lifecycle;
    const before = lifecycle.snapshot().rendererReplacements;
    lifecycle.forceOverflow();
    const deadline = performance.now() + 20_000;
    while (lifecycle.snapshot().rendererReplacements < before + 1) {
      if (performance.now() > deadline) { throw new Error('renderer overflow did not rebuild'); }
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    window.clipboardHarness.emit('CAPTURE-REPAIRED\r\n', {
      bootstrap: { requestedLines: 4, truncated: false },
    });
    const captureDeadline = performance.now() + 15_000;
    while (!lifecycle.snapshot().bufferTail.includes('CAPTURE-REPAIRED')) {
      if (performance.now() > captureDeadline) { throw new Error('bootstrap capture was not applied'); }
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    return lifecycle.snapshot();
  });
  expect(repaired.rendererReplacements).toBeGreaterThanOrEqual(1);
  expect(repaired.bufferTail).toContain('CAPTURE-REPAIRED');

  // 3) Same-Session detach/reattach preserves the intended buffer.
  const history = await page.evaluate(async ({ marker, lines }) => {
    const lifecycle = window.clipboardHarness.lifecycle;
    const output = Array.from({ length: lines }, (_, index) => marker + '-' + index).join('\r\n');
    window.clipboardHarness.emit(output + '\r\n');
    const deadline = performance.now() + 15_000;
    while (!lifecycle.snapshot().bufferTail.includes(marker + '-' + (lines - 1))) {
      if (performance.now() > deadline) { throw new Error('history was not applied'); }
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    const before = lifecycle.snapshot();
    lifecycle.detach();
    const detached = lifecycle.snapshot();
    lifecycle.attachNewHost();
    const reattached = lifecycle.snapshot();
    return { before, detached, reattached };
  }, { marker: historyMarker, lines: HISTORY_LINES });
  expect(history.detached.terminalId).toBeNull();
  expect(history.reattached.terminalId).toBe(history.before.terminalId);
  expect(history.reattached.bufferTail).toContain(historyMarker + '-' + (HISTORY_LINES - 1));

  // 4) One keystroke after reattach reaches the transport exactly once.
  await page.evaluate(() => window.clipboardHarness.focus());
  const beforeInput = await page.evaluate(() => window.clipboardHarness.sent.length);
  await page.keyboard.type('x');
  await page.waitForTimeout(100);
  const afterInput = await page.evaluate(() => window.clipboardHarness.sent.length);
  expect(afterInput - beforeInput).toBe(1);

  return { ordering, repaired, history };
}

test('SC-05: ordering, CAPTURE repair, history reattach and single input survive in Web and App', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-05');

  await openLifecycleFixture(page);
  const web = await exerciseTerminal(page, { prefix: 'W', historyMarker: 'WEB-HISTORY' });

  await openLifecycleFixture(page, '?experience=app');
  const app = await exerciseTerminal(page, { prefix: 'A', historyMarker: 'APP-HISTORY' });

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': Web and App each applied ' + BURST_LINES +
      ' numbered lines exactly once (unique=' + web.ordering.unique + '/' + app.ordering.unique +
      ', contiguous); a real writer overflow rebuilt the renderer and the bootstrap capture ' +
      'CAPTURE-REPAIRED was parsed into the replacement; detach/reattach kept the same xterm ' +
      'and its history (WEB-HISTORY-499 / APP-HISTORY-499); one keystroke after reattach ' +
      'produced one transport frame',
  });
});
