'use strict';
// #2592 SC-02: at every canonical App width the complete fixed grid is centred
// inside the deliberate symmetric inset, with the first and last columns
// visible and no horizontal scrolling.
const { test, expect } = require('@playwright/test');
const {
  APP_VIEWPORTS, verifiedRuntime, openAppFixture, measureApp,
} = require('../../../shared/terminal-density-cases.cjs');

test('SC-02: centred full 96-column grid with symmetric gutters', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  const evidence = [];

  for (const [width, height] of APP_VIEWPORTS) {
    await openAppFixture(page, width, height);
    const m = await measureApp(page);
    const label = width + 'x' + height + ' ' + JSON.stringify(m);

    expect(m.cols, label).toBe(96);
    expect(m.fit, label).toBe('true');
    expect(m.cellWidth, label).toBeGreaterThan(0);
    expect(m.gridWidth, label).toBeLessThanOrEqual(m.contentBoxWidth + 0.5);
    expect(m.screenWidth, label).toBeLessThanOrEqual(m.contentBoxWidth + 0.5);
    expect(m.scrollWidth, 'no horizontal overflow: ' + label).toBe(m.clientWidth);
    expect(m.scrollLeft, label).toBe(0);

    // The painted grid's first and last columns sit inside the owned inset.
    expect(m.screenLeft, 'first column visible: ' + label).toBeGreaterThanOrEqual(
      m.hostLeft + m.padL - 1,
    );
    expect(m.screenRight, 'last column visible: ' + label).toBeLessThanOrEqual(
      m.hostRight - m.padR + 1,
    );

    // Deliberate symmetric inset: the residual space on the two sides is
    // shared; renderer rounding may leave one CSS pixel of difference.
    const leftGutter = m.screenLeft - m.hostLeft;
    const rightGutter = m.hostRight - m.screenRight;
    expect(Math.abs(leftGutter - rightGutter), 'balanced gutters: ' + label)
      .toBeLessThanOrEqual(1);
    expect(leftGutter, 'the inset is deliberate: ' + label).toBeGreaterThan(0);
    evidence.push(width + 'px gutters ' + leftGutter.toFixed(2) + '/' + rightGutter.toFixed(2) +
      ' grid ' + m.gridWidth.toFixed(2) + ' of ' + m.contentBoxWidth.toFixed(2) +
      ' font ' + m.fontSize);
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + evidence.join('; ') +
      '; every width: cols=96, data-terminal-cols-fit=true, no horizontal scroll',
  });
});
