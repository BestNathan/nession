'use strict';
// #2614 SC-03: the UI and protocol distinguish an HTTP origin's unsupported
// **automatic** OSC 52/5522 writes from the supported user-triggered paths —
// native text paste and native image paste into an OSC 5522 TUI. A TUI that
// has not opted in receives no image bytes and only a minimal indication.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, parseFrames, dispatchPaste,
} = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  fixtureImage, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

// Only the secure-origin half needs clipboard permission; the HTTP half has no
// async API at all, which is the point.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('SC-03: HTTP automatic writes are refused while user-triggered paths work', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-03');
  const observed = [];

  // 1. Secure origin keeps the programmatic write; no copy-required state.
  await openClipboardFixture(page);
  const secure = await originCapability(page);
  expect(secure.secure).toBe(true);
  expect(secure.hasAsyncClipboard).toBe(true);
  await emit(page, '\x1b]52;c;' + b64('secure-clipboard') + '\x1b\\');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('secure-clipboard');
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);
  observed.push('secure origin: OSC 52 write applied programmatically, no notice');

  const origin = await startHttpOrigin(repoRoot);
  try {
    // 2. HTTP: the same automatic write is refused truthfully — the user gets
    //    the actionable copy state, not a claim.
    await openHttpClipboard(page, origin.origin);
    const insecure = await originCapability(page);
    expect(insecure.secure).toBe(false);
    expect(insecure.hasAsyncClipboard).toBe(false);
    await emit(page, '\x1b]52;c;' + b64('http-refused') + '\x1b\\');
    await expect(page.getByTestId('terminal-clipboard-notice'))
      .toHaveAttribute('data-clipboard-notice', 'copy-required');
    observed.push('HTTP origin: automatic OSC 52 write refused as copy-required');

    // 3. HTTP + no 5522 opt-in: an image-only paste is not injected; the user
    //    gets the minimal unsupported indication and the TUI gets no bytes.
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: fixtureImage(512) }] });
    await expect(page.getByTestId('terminal-clipboard-notice'))
      .toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
    expect(await sentFrames(page)).toEqual([]);
    observed.push('HTTP origin: unnegotiated image paste reported, zero bytes sent');

    // 4. HTTP + 5522 opt-in: the native paste event itself carries the image
    //    into a `type=read` announcement. There is no navigator.clipboard on
    //    this origin, so this path provably does not depend on it.
    await emit(page, '\x1b[?5522h');
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    const paste = await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: fixtureImage(512) }] });
    expect(paste.delivered, 'the paste must be intercepted as an image offer').toBe(true);
    expect(paste.defaultPrevented).toBe(true);
    await expect.poll(async () => (await sentFrames(page)).join('')).toContain('type=read');
    const frames = parseFrames(await sentFrames(page));
    const announcement = frames.find((frame) => frame.metadata.has('pw'));
    expect(announcement, 'the TUI receives the one-time password').toBeTruthy();
    expect(Buffer.from(announcement.payload, 'base64').toString('utf8').split(' '))
      .toContain('image/png');
    observed.push('HTTP origin: native image paste announced over OSC 5522 with a one-time pw');

    // 5. Text paste is a native gesture too and stays unaffected on HTTP.
    await emit(page, '\x1b[?2004h');
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await dispatchPaste(page, { text: 'http text paste' });
    await expect.poll(async () => (await sentFrames(page)).join(''))
      .toContain('http text paste');
    observed.push('HTTP origin: native text paste delivered');
  } finally {
    await origin.close();
  }

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': ' + observed.join('; ') +
      '; the secure origin used navigator.clipboard, the HTTP origin had none and still ' +
      'delivered image/text through native paste events',
  });
});
