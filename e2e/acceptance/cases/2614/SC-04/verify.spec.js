'use strict';
// #2614 SC-04: the HTTP fix must not disturb the paths that already worked —
// native text paste (normal and bracketed), mixed text+image paste, the
// observer/foreground authority gate, replay provenance, and the IME/input
// suites. The runtime half runs the source-aligned suites; the browser half
// proves the gestures on the production fixture.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, parseFrames, dispatchPaste,
} = require('../../../shared/terminal-clipboard-cases.cjs');
const { fixtureImage } = require('../../../shared/terminal-http-clipboard-cases.cjs');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const clearSent = (page) => page.evaluate(() => { window.clipboardHarness.sent.length = 0; });

test('SC-04: text paste, mixed paste and authority gates stay exact on the real fixture', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-04');
  const observed = [];
  await openClipboardFixture(page);

  // Bracketed paste: the mode the application set decides the wrapping bytes.
  await emit(page, '\x1b[?2004h');
  await page.waitForTimeout(150);
  await clearSent(page);
  await dispatchPaste(page, { text: 'bracketed value' });
  await expect.poll(async () => (await sentFrames(page)).join(''))
    .toContain('\x1b[200~bracketed value\x1b[201~');
  observed.push('bracketed text paste wrapped exactly once');

  // Normal mode: the same paste carries no wrapping bytes.
  await emit(page, '\x1b[?2004l');
  await page.waitForTimeout(150);
  await clearSent(page);
  await dispatchPaste(page, { text: 'plain value' });
  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('plain value');
  expect((await sentFrames(page)).join('')).not.toContain('\x1b[200~');
  observed.push('normal text paste stays unwrapped');

  // Mixed text + image: the text still reaches the PTY and the image becomes a
  // 5522 offer with its one-time password.
  await emit(page, '\x1b[?5522h');
  await page.waitForTimeout(150);
  await clearSent(page);
  await dispatchPaste(page, { text: 'mixed text', images: [{ mime: 'image/png', bytes: fixtureImage(256) }] });
  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('mixed text');
  expect(parseFrames(await sentFrames(page)).some((frame) => frame.metadata.has('pw'))).toBe(true);
  observed.push('mixed paste delivered text and announced the image');

  // Observer: no clipboard effect and no notice while another client controls.
  await page.evaluate(() => window.clipboardHarness.setObserver(true));
  const beforeObserver = await readClipboard(page);
  await emit(page, '\x1b]52;c;' + Buffer.from('observer-must-not', 'utf8').toString('base64') + '\x1b\\');
  await page.waitForTimeout(400);
  expect(await readClipboard(page)).toBe(beforeObserver);
  expect(await page.getByTestId('terminal-clipboard-notice').count()).toBe(0);
  observed.push('observer performed no clipboard effect');

  // Controller again: the same frame now applies.
  await page.evaluate(() => window.clipboardHarness.setObserver(false));
  await emit(page, '\x1b]52;c;' + Buffer.from('controller-applies', 'utf8').toString('base64') + '\x1b\\');
  await expect.poll(() => readClipboard(page)).toBe('controller-applies');
  observed.push('foreground controller applied the write');

  // Replay: a bootstrap-origin frame is history, not a live effect.
  const beforeReplay = await readClipboard(page);
  await emit(page, '\x1b]52;c;' + Buffer.from('replay-must-not', 'utf8').toString('base64') + '\x1b\\', {
    bootstrap: { requestedLines: 5, truncated: false, cutConsistency: 'atomic', fidelity: 'full-vt', streamEpoch: 3 },
  });
  await page.waitForTimeout(400);
  expect(await readClipboard(page)).toBe(beforeReplay);
  observed.push('replay output produced no clipboard effect');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the runtime half runs the interaction, IME and controller suites',
  });
});
