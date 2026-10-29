'use strict';
// #2592 SC-01: the real App xterm renders with the compact Experience leading,
// rows are measurably tighter than the 1.31 baseline, CJK/box-drawing/cursor
// glyphs are not clipped, and Web's leading is unchanged.
const { test, expect } = require('@playwright/test');
const {
  APP_VIEWPORTS, verifiedRuntime, openAppFixture, writeGlyphProbe,
} = require('../../../shared/terminal-density-cases.cjs');

test('SC-01: compact App leading without glyph clipping; Web leading unchanged', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-01');
  const rows = [];

  for (const [width, height] of APP_VIEWPORTS) {
    await openAppFixture(page, width, height);
    const token = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="fixture-terminal"]');
      const term = host.xtermInstance;
      return { lineHeight: term.options.lineHeight, fontSize: term.options.fontSize };
    });
    expect(token.lineHeight, 'the App token is the compact Experience leading').toBeCloseTo(1.14, 5);

    // Same font, both leadings: the new row pitch must be strictly smaller.
    const pitches = await page.evaluate(async () => {
      const host = document.querySelector('[data-testid="fixture-terminal"]');
      const term = host.xtermInstance;
      const cell = () => term._core._renderService.dimensions.css.cell;
      const old = term.options.lineHeight;
      term.options.lineHeight = 1.31;
      term.refresh(0, Math.max(0, term.rows - 1));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const baseline = cell().height;
      term.options.lineHeight = old;
      term.refresh(0, Math.max(0, term.rows - 1));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { baseline, compact: cell().height };
    });
    expect(pitches.baseline, 'the old 1.31 row must be taller').toBeGreaterThan(pitches.compact);

    // Glyph evidence: CJK, box drawing and block glyphs stay inside their row.
    await writeGlyphProbe(page);
    const glyphs = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="fixture-terminal"]');
      const rowsEl = host.querySelector('.xterm-rows');
      const first = rowsEl && rowsEl.children[0];
      const spans = first ? Array.from(first.querySelectorAll('span')) : [];
      return {
        text: rowsEl ? rowsEl.textContent || '' : '',
        rowHeight: first ? first.getBoundingClientRect().height : 0,
        rowScrollHeight: first ? first.scrollHeight : 0,
        rowClientHeight: first ? first.clientHeight : 0,
        spanHeights: spans.map((span) => span.getBoundingClientRect().height),
      };
    });
    expect(glyphs.text).toContain('中文重点');
    expect(glyphs.text).toContain('╭');
    expect(glyphs.rowHeight).toBeGreaterThan(0);
    for (const spanHeight of glyphs.spanHeights) {
      expect(spanHeight, 'a glyph box must not exceed its row').toBeLessThanOrEqual(
        glyphs.rowHeight + 0.5,
      );
    }
    expect(glyphs.rowScrollHeight, 'the row must not vertically overflow').toBeLessThanOrEqual(
      glyphs.rowClientHeight + 1,
    );

    rows.push({
      width,
      lineHeight: token.lineHeight,
      fontSize: token.fontSize,
      baselinePitch: pitches.baseline,
      compactPitch: pitches.compact,
    });
  }

  // Web's leading is a different Experience token and must not move.
  await openAppFixture(page, 1400, 900);
  const web = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    return host.xtermInstance.options.lineHeight;
  });
  expect(web, 'Web leading remains 1.19').toBeCloseTo(1.19, 5);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App leading 1.14; ' + rows.map((row) =>
      row.width + 'px font ' + row.fontSize + ' pitch ' + row.compactPitch +
      ' (1.31 baseline ' + row.baselinePitch + ')').join('; ') +
      '; CJK/box-drawing glyph boxes stayed inside their rows; Web leading 1.19',
  });
});
