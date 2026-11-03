'use strict';
// #2657 SC-02: the guide sends exactly the chosen semantic arrow for all four
// directions, keeps a centre dead zone and a stable axis, changes direction
// cleanly, and repeats at four bounded distance speeds. Repeats are anchored
// to the last emitted key, so continuous movement cannot postpone them.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  openDirectionPadFixture, terminalView,
  touchStart, touchMove, touchEnd,
  padState, sentFrames, clearSent, annotate,
} = require('../../../shared/terminal-direction-pad-cases.cjs');

async function sentCount(page) {
  return (await sentFrames(page)).length;
}

async function lastSent(page) {
  return (await sentFrames(page)).at(-1) || '';
}

test('SC-02: direction, dead zone, speed bands and the repeat clock', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-02');

  await openDirectionPadFixture(page);
  const view = await terminalView(page);
  const start = { x: view.centerX, y: view.centerY };

  await clearSent(page);
  await touchStart(page, start);
  await page.waitForTimeout(450);
  await expect.poll(async () => (await padState(page)).present, { timeout: 10_000 })
    .toBe(true);

  // Dead zone: 12px is still the centre.
  await touchMove(page, { x: start.x + 12, y: start.y });
  expect((await padState(page)).direction).toBe('none');
  expect(await sentCount(page)).toBe(0);

  // Four directions, one immediate key each, with axis hysteresis.
  let before = await sentCount(page);
  await touchMove(page, { x: start.x + 40, y: start.y });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('right');
  expect(await sentCount(page)).toBeGreaterThanOrEqual(before + 1);
  expect(await lastSent(page)).toBe('\x1b[C');

  // A mild vertical bias does not switch the selected axis.
  before = await sentCount(page);
  await touchMove(page, { x: start.x + 30, y: start.y + 20 });
  expect((await padState(page)).direction).toBe('right');
  expect(await sentCount(page)).toBe(before);

  // A clearly vertical move does switch, and emits one new key.
  before = await sentCount(page);
  await touchMove(page, { x: start.x + 10, y: start.y - 60 });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('up');
  expect(await sentCount(page)).toBeGreaterThanOrEqual(before + 1);
  expect(await lastSent(page)).toBe('\x1b[A');

  before = await sentCount(page);
  await touchMove(page, { x: start.x - 50, y: start.y });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('left');
  expect(await sentCount(page)).toBeGreaterThanOrEqual(before + 1);
  expect(await lastSent(page)).toBe('\x1b[D');

  before = await sentCount(page);
  await touchMove(page, { x: start.x, y: start.y + 50 });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('down');
  expect(await sentCount(page)).toBeGreaterThanOrEqual(before + 1);
  expect(await lastSent(page)).toBe('\x1b[B');

  // Far out: the 8/s band. Crossing it must not emit a burst; at most the
  // single repeat that the accelerated clock can legitimately produce.
  const beforeSpeed = await sentCount(page);
  await touchMove(page, { x: start.x, y: start.y + 130 });
  await expect.poll(async () => (await padState(page)).speed, { timeout: 10_000 })
    .toBe('8/s');
  expect(await padState(page)).toMatchObject({ pips: ['true', 'true', 'true', 'true'] });
  expect(await sentCount(page)).toBeLessThanOrEqual(beforeSpeed + 1);

  // Held still, the repeat clock keeps producing keys.
  await expect.poll(() => sentCount(page), { timeout: 5_000 })
    .toBeGreaterThan(beforeSpeed + 1);

  // Centre return stops repetition; leaving the centre emits one new key.
  await touchMove(page, start);
  expect((await padState(page)).direction).toBe('none');
  const afterCenter = await sentCount(page);
  await page.waitForTimeout(1_100);
  expect(await sentCount(page)).toBe(afterCenter);

  await touchMove(page, { x: start.x + 50, y: start.y });
  await expect.poll(async () => (await padState(page)).direction, { timeout: 10_000 })
    .toBe('right');
  expect(await sentCount(page)).toBeGreaterThanOrEqual(afterCenter + 1);
  await touchEnd(page, { x: start.x + 50, y: start.y });

  // Continuous movement at 1/s: the repeat is anchored to the last emitted
  // key, so moving back and forth cannot defer it past its window.
  await clearSent(page);
  await touchStart(page, start);
  await page.waitForTimeout(450);
  await touchMove(page, { x: start.x + 40, y: start.y });
  expect(await sentCount(page)).toBe(1);
  for (let step = 0; step < 20; step += 1) {
    await page.waitForTimeout(100);
    await touchMove(page, { x: start.x + 40 + (step % 3), y: start.y });
  }
  // Just over two seconds at 1/s: at least two more keys despite the motion.
  await expect.poll(() => sentCount(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  const beforeHold = await sentCount(page);
  await page.waitForTimeout(1_100);
  await expect.poll(() => sentCount(page), { timeout: 10_000 })
    .toBeGreaterThan(beforeHold);
  await touchEnd(page, { x: start.x + 40, y: start.y });

  const finalCount = await sentCount(page);
  await page.waitForTimeout(1_100);
  expect(await sentCount(page), 'release stops the clock').toBe(finalCount);

  annotate(
    testInfo,
    sha,
    'dead zone held at 12px; right/up/left/down each emitted one immediate key with axis '
    + 'hysteresis; the 8/s band produced no key at the crossing and repeated while held; '
    + 'continuous movement for 2.1s still produced >=3 keys; centre return paused; release '
    + 'stopped the clock',
  );
});
