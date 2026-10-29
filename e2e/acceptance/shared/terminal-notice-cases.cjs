'use strict';
// Shared browser machinery for the #2621 Terminal status-overlay Cases.
//
// Every Case drives a canonical fixture route that mounts the production
// `TerminalSurface` + engine:
//
//   /#/fixture/app?...        the App experience at 390x844 (DOM renderer)
//   /#/fixture/clipboard?...  the Web experience with a real TerminalController
//
// The route parameters name the *inputs* the runtime would have answered with
// (see fixtureStatusNotices.ts); the surface decides what to draw. Measurement
// and navigation stay here; the Cases own only the criteria.
async function openRoute(page, route, marker) {
  // Leave the document first: a second goto to the same hash URL is a
  // same-document navigation, so a Case would otherwise keep the old terminal.
  await page.goto('about:blank');
  await page.goto('/#' + route);
  if (marker) {
    await page.waitForFunction(
      (needle) => {
        const rows = document.querySelector('.xterm-rows');
        return rows !== null && (rows.textContent || '').includes(needle);
      },
      marker,
      { timeout: 25_000 },
    );
  }
  await settle(page);
}

/** The App fixture: the product's App composition at the canonical 390x844. */
async function openAppNotices(page, params = '') {
  await openRoute(page, '/fixture/app' + params, '$ git status --short');
}

/** The Web fixture: the production controller and a real xterm at any width. */
async function openWebNotices(page, params = '') {
  await page.goto('about:blank');
  await page.goto('/#/fixture/clipboard' + params);
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness) && Boolean(
    document.querySelector('[data-testid="fixture-clipboard-host"] .xterm-screen'),
  ));
  await settle(page);
}

/**
 * Wait until the measured grid is identical for two consecutive frames.
 *
 * A fixture fits its grid over a bounded settle window after the face it
 * measures with loads; sampling one arbitrary frame can catch a mid-fit grid
 * and make a comparison between routes disagree for a reason unrelated to the
 * overlay.
 */
async function settle(page) {
  await page.evaluate(async () => {
    const read = () => {
      const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const term = visible && visible.parentElement && visible.parentElement.xtermInstance;
      const host = document.querySelector('[data-terminal-capsule-host]');
      return [
        term && term.rows,
        term && term.cols,
        host && Math.round(host.getBoundingClientRect().height),
      ].join('|');
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

/**
 * The grid and the boxes that must not move when a status notice appears.
 * `overlay` is reported separately because its presence is the variable.
 */
async function readGeometry(page, viewportTestId) {
  return page.evaluate((testId) => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = visible && visible.parentElement && visible.parentElement.xtermInstance;
    const host = document.querySelector('[data-terminal-capsule-host]');
    const surface = document.querySelector('[data-testid="terminal-surface"]');
    const viewport = document.querySelector('[data-testid="' + testId + '"]');
    const overlay = document.querySelector('[data-testid="terminal-status-overlay"]');
    return {
      rows: term ? term.rows : -1,
      cols: term ? term.cols : -1,
      host: box(host),
      surface: box(surface),
      viewport: box(viewport),
      overlay: box(overlay),
      domRows: document.querySelector('.xterm-rows')
        ? document.querySelector('.xterm-rows').children.length
        : 0,
    };
  }, viewportTestId);
}

/** The part of `readGeometry` that must be identical with and without notices. */
function stablePart(geometry) {
  const { overlay, ...rest } = geometry;
  void overlay;
  return rest;
}

/** The four inputs, in one route, to prove they stack without reserving height. */
const ALL_FOUR = '?history=degraded&drop=epoch&role=observer&clipboard=write-denied';

module.exports = {
  ALL_FOUR,
  openAppNotices,
  openWebNotices,
  readGeometry,
  stablePart,
};
