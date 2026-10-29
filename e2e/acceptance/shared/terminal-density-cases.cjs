'use strict';
// Shared browser machinery for the #2592 App terminal-density Cases.
//
// Every Case drives the canonical App fixture route: it mounts the product's
// real `TerminalSurface` and `XtermEmulator` at the App Experience, with the
// same `fitFontToColumns` policy the live `TerminalGeometry` uses. The Cases
// own only the criteria; measurement and fixture navigation stay here.
const { verifiedRuntime } = require('./foreground-resume-browser.cjs');

/** The canonical App viewports named by the requirement. */
const APP_VIEWPORTS = [
  [375, 812],
  [390, 844],
  [393, 852],
  [430, 932],
  [440, 956],
];

/** Narrow stress widths used to prove the absence of a 6px application floor. */
const BELOW_SIX_VIEWPORTS = [
  [320, 700],
  [340, 700],
];

const FIXTURE_MARKER = '$ git status --short';

async function openAppFixture(page, width, height) {
  await page.setViewportSize({ width, height });
  // Leave the document first: a second `goto` to the same hash URL is a
  // same-document navigation, so a Case that rewrote the fixture buffer would
  // otherwise keep the old terminal and never see the marker again.
  await page.goto('about:blank');
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-root').waitFor();
  await page.waitForFunction((marker) => {
    const rows = document.querySelector('.xterm-rows');
    return rows !== null && rows.textContent.includes(marker);
  }, FIXTURE_MARKER, { timeout: 25_000 });
  await page.evaluate(() => document.fonts.ready);
  await waitForStableFit(page);
}

/**
 * Wait until the measured grid has been identical for two consecutive frames.
 *
 * The fixture opens xterm after the face it measures with has loaded and then
 * fits for a bounded settle window; this waits for that window to converge
 * instead of sampling one arbitrary frame.
 */
async function waitForStableFit(page) {
  await page.evaluate(async () => {
    const read = () => {
      const host = document.querySelector('[data-testid="fixture-terminal"]');
      const term = host && host.xtermInstance;
      const cell = term && term._core && term._core._renderService
        && term._core._renderService.dimensions
        && term._core._renderService.dimensions.css
        && term._core._renderService.dimensions.css.cell;
      return [host && host.clientWidth, host && host.clientHeight,
        term && term.cols, term && term.options.fontSize,
        cell && cell.width, cell && cell.height].join('|');
    };
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let previous = read();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await frame();
      const next = read();
      if (next === previous) return;
      previous = next;
    }
    throw new Error('the fixture grid did not settle: ' + read());
  });
}

/** The App fixture's grid, font, content box and painted bounds. */
async function measureApp(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    const term = host && host.xtermInstance;
    const cell = term && term._core && term._core._renderService
      && term._core._renderService.dimensions
      && term._core._renderService.dimensions.css
      && term._core._renderService.dimensions.css.cell;
    const style = host ? getComputedStyle(host) : null;
    const hostRect = host ? host.getBoundingClientRect() : null;
    const screen = host ? host.querySelector('.xterm-screen') : null;
    const screenRect = screen ? screen.getBoundingClientRect() : null;
    const padL = style ? Number.parseFloat(style.paddingLeft) : Number.NaN;
    const padR = style ? Number.parseFloat(style.paddingRight) : Number.NaN;
    const contentWidth = style
      ? Number.parseFloat(style.getPropertyValue('--nession-local-terminal-content-width'))
      : Number.NaN;
    const cols = term ? term.cols : 0;
    return {
      cols,
      rows: term ? term.rows : 0,
      fontSize: term ? term.options.fontSize : Number.NaN,
      lineHeight: term ? term.options.lineHeight : Number.NaN,
      cellWidth: cell ? cell.width : Number.NaN,
      cellHeight: cell ? cell.height : Number.NaN,
      gridWidth: cell ? cols * cell.width : Number.NaN,
      contentBoxWidth: host ? host.clientWidth - padL - padR : Number.NaN,
      contentWidthVar: contentWidth,
      padL,
      padR,
      hostLeft: hostRect ? hostRect.left : Number.NaN,
      hostRight: hostRect ? hostRect.right : Number.NaN,
      screenLeft: screenRect ? screenRect.left : Number.NaN,
      screenRight: screenRect ? screenRect.right : Number.NaN,
      screenWidth: screenRect ? screenRect.width : Number.NaN,
      fit: host ? host.dataset.terminalColsFit : undefined,
      scrollWidth: host ? host.scrollWidth : Number.NaN,
      clientWidth: host ? host.clientWidth : Number.NaN,
      scrollLeft: host ? host.scrollLeft : Number.NaN,
      rowBoxes: host
        ? Array.from(host.querySelectorAll('.xterm-rows > div')).slice(0, 3)
          .map((el) => el.getBoundingClientRect().height)
        : [],
    };
  });
}

/** Type a probe line into the fixture buffer (CJK, box drawing, block glyphs). */
async function writeGlyphProbe(page) {
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="fixture-terminal"]');
    const term = host.xtermInstance;
    term.write('\x1b[2J\x1b[H');
    term.write('中文重点 ╭─╮╰─╯ ┃┃┗┛ █▓▒░ hello, world\r\n');
    term.write('The quick brown fox jumps over the lazy dog 0123456789\r\n');
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

module.exports = {
  APP_VIEWPORTS,
  BELOW_SIX_VIEWPORTS,
  FIXTURE_MARKER,
  verifiedRuntime,
  openAppFixture,
  waitForStableFit,
  measureApp,
  writeGlyphProbe,
};
