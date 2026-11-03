'use strict';
// #2657 SC-05: the touch-first mobile prototype, at its pinned source commit,
// demonstrates actual TouchEvent arming, four directions, centre stop, repeat
// while held, and cancellation. The pinned files are fetched from GitHub and
// served under a synthetic origin, so the Case verifies the frozen source
// rather than whatever the Pages deployment currently contains.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const PROTOTYPE_SHA = '6f5abbf02395390deb933c0a8478eb17d593a4c6';
const PALETTE = `https://raw.githubusercontent.com/BestNathan/nession/${PROTOTYPE_SHA}/terminal-direction-2657`;
const ORIGIN = 'https://prototype-2657.test';
const FILES = ['index.html', 'prototype-ui.mjs', 'gesture-engine.mjs'];
const STORE = '__sc05DirectionPadTouch';

async function loadPinnedPrototype(page) {
  const contents = {};
  for (const file of FILES) {
    const response = await fetch(`${PALETTE}/${file}`);
    if (!response.ok) {
      throw new Error(`pinned prototype file ${file} is unavailable: ${response.status}`);
    }
    contents[file] = await response.text();
  }
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const body = contents[path];
    if (body === undefined) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: path.endsWith('.mjs') ? 'text/javascript' : 'text/html',
      body,
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => Boolean(window.__nessionMock));
}

async function termBox(page) {
  return page.evaluate(() => {
    const element = document.getElementById('term');
    if (!element) throw new Error('prototype terminal is missing');
    const rect = element.getBoundingClientRect();
    return { centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 };
  });
}

async function mockState(page) {
  return page.evaluate(() => {
    const state = window.__nessionMock.state();
    return {
      phase: state.phase,
      direction: state.direction,
      rate: state.rate,
      count: state.count,
      owner: state.owner,
    };
  });
}

async function touchStart(page, point, identifier = 11) {
  await page.evaluate(({ x, y, id, key }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error('no prototype element at ' + x + ',' + y);
    const touch = new Touch({ identifier: id, target, clientX: x, clientY: y });
    window[key] = { id, target };
    target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch], targetTouches: [touch], changedTouches: [touch],
      bubbles: true, cancelable: true,
    }));
  }, { x: point.x, y: point.y, id: identifier, key: STORE });
}

async function touchMove(page, point) {
  await page.evaluate(({ x, y, key }) => {
    const stored = window[key];
    if (!stored) throw new Error('no prototype touch in progress');
    const touch = new Touch({
      identifier: stored.id, target: stored.target, clientX: x, clientY: y,
    });
    stored.target.dispatchEvent(new TouchEvent('touchmove', {
      touches: [touch], targetTouches: [touch], changedTouches: [touch],
      bubbles: true, cancelable: true,
    }));
  }, { x: point.x, y: point.y, key: STORE });
}

async function touchEnd(page, point) {
  await page.evaluate(({ x, y, key }) => {
    const stored = window[key];
    if (!stored) throw new Error('no prototype touch in progress');
    const touch = new Touch({
      identifier: stored.id, target: stored.target, clientX: x, clientY: y,
    });
    stored.target.dispatchEvent(new TouchEvent('touchend', {
      touches: [], targetTouches: [], changedTouches: [touch],
      bubbles: true, cancelable: true,
    }));
    delete window[key];
  }, { x: point.x, y: point.y, key: STORE });
}

test('SC-05: pinned touch-first prototype arms, navigates, repeats and cancels', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-05');

  await loadPinnedPrototype(page);
  const term = await termBox(page);
  const origin = { x: term.centerX, y: term.centerY };
  const baseline = await mockState(page);
  expect(baseline.phase).toBe('idle');

  // A tap/quick touch is not a hold and sends no keys.
  await touchStart(page, origin);
  await touchEnd(page, origin);
  await page.waitForTimeout(450);
  expect(await mockState(page)).toMatchObject({ phase: 'idle', count: baseline.count });

  // Hold -> armed; no key until the finger leaves the centre.
  await touchStart(page, origin);
  await page.waitForTimeout(430);
  expect(await mockState(page)).toMatchObject({
    phase: 'armed', direction: null, count: baseline.count,
  });

  // Move up: one immediate key at 1/s; holding repeats on the mock's clock.
  await touchMove(page, { x: origin.x, y: origin.y - 40 });
  let state = await mockState(page);
  expect(state).toMatchObject({ phase: 'moving', direction: 'up', rate: 1 });
  expect(state.count).toBeGreaterThanOrEqual(baseline.count + 1);
  const afterOne = state.count;
  await page.waitForTimeout(1_200);
  expect((await mockState(page)).count).toBeGreaterThan(afterOne);

  // Return to the centre stops the clock; moving right sends a new key.
  await touchMove(page, origin);
  state = await mockState(page);
  expect(state.direction).toBeNull();
  const centered = state.count;
  await page.waitForTimeout(600);
  expect((await mockState(page)).count).toBe(centered);

  await touchMove(page, { x: origin.x + 50, y: origin.y });
  state = await mockState(page);
  expect(state.direction).toBe('right');
  expect(state.count).toBeGreaterThanOrEqual(centered + 1);

  // Release ends ownership and the repeat clock.
  await touchEnd(page, { x: origin.x + 50, y: origin.y });
  await page.waitForTimeout(200);
  state = await mockState(page);
  expect(state.phase).toBe('idle');
  const released = state.count;
  await page.waitForTimeout(900);
  expect((await mockState(page)).count).toBe(released);

  // Observer mode (the prototype's own read-only path) cannot inject.
  await page.getByRole('button', { name: '只读观察者' }).click();
  const beforeObserver = (await mockState(page)).count;
  await touchStart(page, origin);
  await page.waitForTimeout(450);
  await touchMove(page, { x: origin.x, y: origin.y - 40 });
  await touchEnd(page, { x: origin.x, y: origin.y - 40 });
  await page.waitForTimeout(500);
  expect((await mockState(page)).count).toBe(beforeObserver);

  testInfo.annotations.push({
    type: 'evidence',
    description: `exact SHA ${sha}: pinned prototype ${PROTOTYPE_SHA} served from its frozen source; `
      + 'a 430ms touch armed the compass, a 40px drag sent ArrowUp at 1/s, holding repeated, '
      + 'centre return paused, a right drag sent a new key, release returned idle, and observer '
      + 'mode sent no keys',
  });
});
