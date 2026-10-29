'use strict';
// #2592 SC-06: the canonical fixture and the live terminal share one measured
// fit, one symmetric-inset presentation and one no-horizontal-scroll rule; the
// App token and canonical docs carry the approved policy.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openAppFixture, measureApp,
} = require('../../../shared/terminal-density-cases.cjs');

test('SC-06: fixture parity with the shared fit and centred presentation', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');
  const evidence = [];

  for (const [width, height] of [[375, 812], [390, 844], [430, 932]]) {
    await openAppFixture(page, width, height);
    const m = await measureApp(page);
    const label = width + 'x' + height + ' ' + JSON.stringify(m);
    expect(m.cols, label).toBe(96);
    expect(m.fit, label).toBe('true');
    expect(m.gridWidth, 'the measured grid is the content width: ' + label)
      .toBeLessThanOrEqual(m.contentBoxWidth + 0.5);
    expect(Math.abs(m.contentWidthVar - m.gridWidth), 'the CSS cap is the measured grid: ' + label)
      .toBeLessThanOrEqual(1);
    expect(m.scrollWidth, 'no horizontal scroll: ' + label).toBe(m.clientWidth);

    const left = m.screenLeft - m.hostLeft;
    const right = m.hostRight - m.screenRight;
    expect(Math.abs(left - right), 'symmetric insets: ' + label).toBeLessThanOrEqual(1);
    evidence.push(width + 'px font ' + m.fontSize + ' grid ' + m.gridWidth.toFixed(1) +
      ' gutters ' + left.toFixed(2) + '/' + right.toFixed(2));
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App fixture uses the shared measured fit at ' +
      evidence.join('; ') + '; same fitFontToColumns owner as TerminalGeometry (runtime half)',
  });
});
