'use strict';
// #2598 SC-03: a live TUI's OSC 52 text write and OSC 5522 MIME write reach the
// authorized foreground browser clipboard exactly once, with a truthful
// acknowledgement; malformed/oversized output is rejected without stalling the
// parser.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, parseFrames,
  recordClipboardTextWrites, clipboardTextWrites, readClipboardText,
} = require('../../../shared/terminal-clipboard-cases.cjs');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-03: OSC 52/5522 writes apply once with truthful replies; invalid input is rejected', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');
  await openClipboardFixture(page);
  await recordClipboardTextWrites(page);

  // OSC 52 text write: one browser write, the same value readable back.
  await emit(page, '\x1b]52;c;' + b64('OSC 52 payload') + '\x1b\\');
  await expect.poll(async () => (await clipboardTextWrites(page)).length).toBe(1);
  expect(await clipboardTextWrites(page)).toEqual(['OSC 52 payload']);
  expect(await readClipboardText(page)).toBe('OSC 52 payload');

  // Invalid base64, a non-clipboard selection and an oversized payload are
  // rejected without another write.
  await emit(page, '\x1b]52;c;!!!!\x1b\\');
  await emit(page, '\x1b]52;p;' + b64('primary only') + '\x1b\\');
  await emit(page, '\x1b]52;c;' + b64('x'.repeat(1024 * 1024 + 8)) + '\x1b\\');
  await page.waitForTimeout(300);
  expect(await clipboardTextWrites(page)).toEqual(['OSC 52 payload']);

  // OSC 5522 MIME write: DONE once, with the multiplexer id echoed unchanged.
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  await emit(page, '\x1b]5522;type=write:id=w-1\x1b\\');
  await emit(page, '\x1b]5522;type=wdata:mime=' + b64('text/plain') + ';' + b64('5522 payload') + '\x1b\\');
  await emit(page, '\x1b]5522;type=wdata\x1b\\');
  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('status=DONE');
  const done = parseFrames(await sentFrames(page)).find((frame) => frame.metadata.get('status') === 'DONE');
  expect(done.metadata.get('id')).toBe('w-1');

  // A malformed write is EINVAL; the parser and a later write are unaffected.
  await page.reload();
  await page.getByTestId('fixture-clipboard').waitFor();
  await page.waitForFunction(() => Boolean(window.clipboardHarness));
  await emit(page, '\x1b]5522;type=write:id=bad\x1b\\');
  await emit(page, '\x1b]5522;type=wdata:mime=' + b64('text/plain') + ';!!!!\x1b\\');
  await emit(page, '\x1b]5522;type=wdata\x1b\\');
  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('status=EINVAL');
  await emit(page, '\x1b]5522;type=write:id=good\x1b\\');
  await emit(page, '\x1b]5522;type=wdata:mime=' + b64('text/plain') + ';' + b64('after error') + '\x1b\\');
  await emit(page, '\x1b]5522;type=wdata\x1b\\');
  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('status=DONE:id=good');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': OSC 52 wrote [OSC 52 payload] exactly once (read back); ' +
      'invalid base64, primary-only selection and a >1 MiB payload produced no write; ' +
      'OSC 5522 text/plain write replied DONE:id=w-1; invalid base64 replied EINVAL and a ' +
      'subsequent write completed DONE:id=good',
  });
});
