'use strict';
// Shared browser machinery for the #2657 Mobile Terminal direction-pad Cases.
//
// `/fixture/clipboard` now mounts the production `TerminalViewport`, so the
// real touch gesture hook, the real interaction controller and the harness
// transport are all in the path. These helpers dispatch real `Touch` objects
// on the element that received `touchstart`; every later event targets that
// same element, as a phone browser does.
const {
  openScrollFixture, terminalView, fillScrollback,
} = require('./terminal-touch-scroll-cases.cjs');
const {
  emit, sentFrames, setObserver,
} = require('./terminal-clipboard-cases.cjs');

const STORE_KEY = '__nessionDirectionPadTouch';

async function openDirectionPadFixture(page, { appShell = false } = {}) {
  await page.goto('about:blank');
  await page.goto('/#/fixture/clipboard' + (appShell ? '?experience=app' : ''));
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness));
  await page.waitForFunction(() => Boolean(
    document.querySelector('[data-testid="fixture-clipboard-host"] [data-terminal-viewport] .xterm-screen'),
  ));
}

async function touchStart(page, point, identifier = 7) {
  await page.evaluate(({ x, y, id, storeKey }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error('no element at ' + x + ',' + y);
    const touch = new Touch({ identifier: id, target, clientX: x, clientY: y });
    window[storeKey] = { id, target };
    target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
  }, { x: point.x, y: point.y, id: identifier, storeKey: STORE_KEY });
}

/** Move the tracked finger; resolves to whether the page prevented default. */
async function touchMove(page, point) {
  return page.evaluate(({ x, y, storeKey }) => {
    const stored = window[storeKey];
    if (!stored) throw new Error('no direction-pad touch in progress');
    const touch = new Touch({
      identifier: stored.id, target: stored.target, clientX: x, clientY: y,
    });
    const event = new TouchEvent('touchmove', {
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    });
    stored.target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { x: point.x, y: point.y, storeKey: STORE_KEY });
}

async function touchEnd(page, point) {
  await finishTouch(page, 'touchend', point);
}

async function touchCancel(page, point) {
  await finishTouch(page, 'touchcancel', point);
}

async function finishTouch(page, type, point) {
  await page.evaluate(({ x, y, kind, storeKey }) => {
    const stored = window[storeKey];
    if (!stored) throw new Error('no direction-pad touch in progress');
    const touch = new Touch({
      identifier: stored.id, target: stored.target, clientX: x, clientY: y,
    });
    stored.target.dispatchEvent(new TouchEvent(kind, {
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
    delete window[storeKey];
  }, { x: point.x, y: point.y, kind: type, storeKey: STORE_KEY });
}

/** Land a second finger while the first is still down (multi-touch). */
async function secondFinger(page, firstPoint, secondPoint) {
  await page.evaluate(({ first, second, storeKey }) => {
    const stored = window[storeKey];
    if (!stored) throw new Error('no direction-pad touch in progress');
    const firstTouch = new Touch({
      identifier: stored.id, target: stored.target,
      clientX: first.x, clientY: first.y,
    });
    const secondTouch = new Touch({
      identifier: stored.id + 1, target: stored.target,
      clientX: second.x, clientY: second.y,
    });
    stored.target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [firstTouch, secondTouch],
      targetTouches: [firstTouch, secondTouch],
      changedTouches: [secondTouch],
      bubbles: true,
      cancelable: true,
    }));
  }, { first: firstPoint, second: secondPoint, storeKey: STORE_KEY });
}

async function padState(page) {
  return page.evaluate(() => {
    const pad = document.querySelector('[data-testid="terminal-direction-pad"]');
    if (!pad) return { present: false };
    const rate = document.querySelector('[data-testid="terminal-direction-pad-rate"]');
    const count = document.querySelector('[data-testid="terminal-direction-pad-count"]');
    return {
      present: true,
      phase: pad.getAttribute('data-phase'),
      direction: pad.getAttribute('data-direction'),
      speed: rate ? rate.textContent : null,
      count: count ? count.textContent : null,
      pips: Array.from(document.querySelectorAll('[data-testid="terminal-direction-pad-speed-pip"]'))
        .map((pip) => pip.getAttribute('data-on')),
      originDot: Boolean(document.querySelector('[data-testid="terminal-direction-pad-origin"]')),
      targetConnected: Boolean(
        document.querySelector('[data-testid="fixture-clipboard-host"] [data-terminal-viewport] .xterm-screen')?.isConnected,
      ),
    };
  });
}

async function sentBytes(page) {
  return (await sentFrames(page)).join('');
}

async function clearSent(page) {
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
}

async function scrollMode(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    return host ? (host.dataset.terminalScrollMode || 'none') : 'none';
  });
}

async function terminalModes(page) {
  return page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = visible && visible.parentElement && visible.parentElement.xtermInstance;
    if (!term) throw new Error('no visible xterm instance');
    return {
      applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
      mouseTrackingMode: term.modes.mouseTrackingMode,
    };
  });
}

function annotate(testInfo, sha, description) {
  testInfo.annotations.push({ type: 'evidence', description: 'exact SHA ' + sha + ': ' + description });
}

module.exports = {
  openDirectionPadFixture,
  openScrollFixture,
  terminalView,
  fillScrollback,
  emit,
  sentFrames,
  setObserver,
  touchStart,
  touchMove,
  touchEnd,
  touchCancel,
  secondFinger,
  padState,
  sentBytes,
  clearSent,
  scrollMode,
  terminalModes,
  annotate,
};
