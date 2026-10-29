'use strict';
// #2614 SC-05 (deployed): the full HTTP positive/negative matrix at the exact
// target SHA, bound by the runner to the authenticated staging deployment
// record. Records the browser, SHA and origin class as evidence; OS-clipboard
// proof that a browser cannot give here is not guessed.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const {
  verifiedRuntime, emit, sentFrames, parseFrames, dispatchPaste, decodeBase64, sha256Hex,
  announcementPassword,
} = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  armCopyProbe, copyProbe, fixtureImage, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-05: the deployed HTTP origin matrix holds at the exact SHA', async ({ page }) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-05');
  const origin = await startHttpOrigin(repoRoot);
  try {
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    expect(capability.secure, 'the deployed matrix must run on an insecure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no async Clipboard API').toBe(false);

    // Negative: an automatic remote write is refused truthfully.
    await emit(page, '\x1b]52;c;' + b64('deployed-negative') + '\x1b\\');
    const notice = page.getByTestId('terminal-clipboard-notice');
    await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');

    // Positive: the user gesture completes the text copy.
    await armCopyProbe(page);
    await notice.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => (await copyProbe(page)).texts).toEqual(['deployed-negative']);
    expect((await copyProbe(page)).executed).toBe(true);
    await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0);

    // Negative: a TUI without OSC 5522 opt-in receives no image bytes.
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await dispatchPaste(page, { images: [{ mime: 'image/png', bytes: fixtureImage(256) }] });
    await expect(page.getByTestId('terminal-clipboard-notice'))
      .toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
    expect(await sentFrames(page)).toEqual([]);

    // Positive: a cooperating TUI receives the image over the negotiated path.
    const bytes = fixtureImage(2048);
    const expectedSha = sha256Hex(bytes);
    await emit(page, '\x1b[?5522h');
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await dispatchPaste(page, { images: [{ mime: 'image/png', bytes }] });
    await expect.poll(async () => (await sentFrames(page)).join('')).toContain('pw=');
    const password = announcementPassword(await sentFrames(page));
    expect(password).toBeTruthy();
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await emit(page, '\x1b]5522;type=read:pw=' + b64(password) + ';' + b64('image/png') + '\x1b\\');
    await expect.poll(async () => (await sentFrames(page)).join('')).toContain('status=DONE');
    const chunks = parseFrames(await sentFrames(page))
      .filter((frame) => frame.metadata.get('status') === 'DATA');
    const received = Buffer.concat(chunks.map((chunk) => decodeBase64(chunk.payload)));
    expect(sha256Hex(received)).toBe(expectedSha);

    test.info().annotations.push({
      type: 'evidence',
      description: 'exact SHA ' + sha + ' (runner-bound staging deployment record); insecure ' +
        'origin ' + origin.origin + ' on ' + userAgent + ': automatic OSC 52 write refused as ' +
        'copy-required and completed by the DOM copy gesture carrying exactly "deployed-negative"; ' +
        'an unnegotiated image paste sent zero bytes; a 5522 TUI received 2048 image/png bytes with ' +
        'SHA-256 ' + expectedSha + '; no secure-context clipboard API existed on the origin',
    });
  } finally {
    await origin.close();
  }
});
