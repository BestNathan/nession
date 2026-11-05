'use strict';
// Shared browser machinery for the #2724 mobile-swipe Cases.
//
// The canonical fixture app (`/#/fixture/app`) mounts the production App
// layers, pager, xterm surface, capsule and Files navigator. These helpers
// dispatch real `Touch` objects on the element that received `touchstart`;
// every later event targets that same element, correlated by
// `Touch.identifier`, which is the ownership a phone browser gives a finger.
const KEY = '__nessionSwipe2724Touch';

async function openFixtureApp(page, query = '', { terminal = true } = {}) {
  await page.goto('/#/fixture/app' + query);
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  if (terminal) {
    await page.locator('.xterm').waitFor({ timeout: 30_000 });
  }
}

async function shellAnchor(page) {
  const layerRoot = page.getByTestId('app-layer-root');
  const shell = await layerRoot.boundingBox();
  if (!shell) {
    throw new Error('the App shell must be laid out');
  }
  // The shell publishes the platform guard it deliberately does not claim
  // (#2724); ordinary edge gestures start just inside it, while `leftGuardX`
  // and `rightGuardX` are the OS-owned strips a Case asserts remain unclaimed.
  const guard = Number(await layerRoot.getAttribute('data-swipe-guard-px'));
  if (!Number.isFinite(guard) || guard < 0) {
    throw new Error('the App shell must publish its platform guard');
  }
  return {
    layerRoot,
    shell,
    guard,
    y: Math.round(shell.y + shell.height / 2),
    leftGuardX: Math.round(shell.x + 2),
    rightGuardX: Math.round(shell.x + shell.width - 2),
    leftX: Math.round(shell.x + guard + 2),
    rightX: Math.round(shell.x + shell.width - guard - 2),
  };
}

async function startTouch(page, point) {
  await page.evaluate(({ x, y, key }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error('no element at ' + x + ',' + y);
    const touch = new Touch({ identifier: 9, target, clientX: x, clientY: y });
    window[key] = { identifier: 9, target };
    target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
  }, { x: point.x, y: point.y, key: KEY });
}

async function moveTouch(page, point) {
  await page.evaluate(({ x, y, key }) => {
    const stored = window[key];
    if (!stored) throw new Error('no swipe touch in progress');
    const touch = new Touch({
      identifier: stored.identifier, target: stored.target, clientX: x, clientY: y,
    });
    stored.target.dispatchEvent(new TouchEvent('touchmove', {
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
  }, { x: point.x, y: point.y, key: KEY });
}

async function finishTouch(page, type, point) {
  await page.evaluate(({ x, y, type, key }) => {
    const stored = window[key];
    if (!stored) throw new Error('no swipe touch in progress');
    const touch = new Touch({
      identifier: stored.identifier, target: stored.target, clientX: x, clientY: y,
    });
    stored.target.dispatchEvent(new TouchEvent(type, {
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
    delete window[key];
  }, { x: point.x, y: point.y, type, key: KEY });
}

async function endTouch(page, point) {
  await finishTouch(page, 'touchend', point);
}

async function cancelTouch(page, point) {
  await finishTouch(page, 'touchcancel', point);
}

async function secondFinger(page, first, second) {
  await page.evaluate(({ first, second, key }) => {
    const stored = window[key];
    if (!stored) throw new Error('no swipe touch in progress');
    const one = new Touch({
      identifier: stored.identifier, target: stored.target, clientX: first.x, clientY: first.y,
    });
    const two = new Touch({
      identifier: stored.identifier + 1, target: stored.target,
      clientX: second.x, clientY: second.y,
    });
    stored.target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [one, two],
      targetTouches: [one, two],
      changedTouches: [two],
      bubbles: true,
      cancelable: true,
    }));
    delete window[key];
  }, { first, second, key: KEY });
}

async function pointerCancellation(page) {
  await page.evaluate((key) => {
    const stored = window[key];
    const target = stored ? stored.target : document.body;
    target.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, pointerId: 9, pointerType: 'touch',
    }));
    target.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: true, pointerId: 9, pointerType: 'touch',
    }));
  }, KEY);
}

async function swipe(page, { from, to, cancel = false }) {
  await startTouch(page, from);
  await moveTouch(page, {
    x: Math.round(from.x + (to.x - from.x) / 2),
    y: from.y,
  });
  await moveTouch(page, to);
  if (cancel) {
    await cancelTouch(page, to);
  } else {
    await endTouch(page, to);
  }
}

function swipeAttr(page) {
  return async (name) => page.getByTestId('app-layer-root').getAttribute(name);
}

module.exports = {
  openFixtureApp,
  shellAnchor,
  startTouch,
  moveTouch,
  endTouch,
  cancelTouch,
  secondFinger,
  pointerCancellation,
  swipe,
  swipeAttr,
};
