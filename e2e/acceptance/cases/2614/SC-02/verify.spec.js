'use strict';
// #2614 SC-02 (deployed): a user-triggered native image-only paste on a real
// HTTP origin reaches a cooperating OSC 5522 TUI as the identical bytes, with
// no navigator.clipboard.read and no upload/path side channel. The runner
// binds this Case to the authenticated staging deployment record for the exact
// target SHA.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, parseFrames, dispatchPaste,
  decodeBase64, sha256Hex, announcementPassword,
} = require('../../../shared/terminal-clipboard-cases.cjs');
const {
  fixtureImage, openHttpClipboard, originCapability, startHttpOrigin,
} = require('../../../shared/terminal-http-clipboard-cases.cjs');

const repoRoot = path.resolve(__dirname, '../../../../..');
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-02: HTTP native image paste reaches the TUI byte-identically over 5522', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');
  const origin = await startHttpOrigin(repoRoot);
  try {
    await openHttpClipboard(page, origin.origin);
    const capability = await originCapability(page);
    expect(capability.secure, 'the deployed Case must use an insecure origin').toBe(false);
    expect(capability.hasAsyncClipboard, 'plain HTTP has no navigator.clipboard').toBe(false);

    const requests = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') { requests.push(request.method() + ' ' + request.url()); }
    });
    const fileChoosers = [];
    page.on('filechooser', (chooser) => { fileChoosers.push(chooser); });

    const bytes = fixtureImage(5000);
    const expectedSha = sha256Hex(bytes);

    await emit(page, '\x1b[?5522h');
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    const paste = await dispatchPaste(page, { images: [{ mime: 'image/png', bytes }] });
    expect(paste.delivered, 'the image-only paste must be captured').toBe(true);
    expect(paste.defaultPrevented).toBe(true);

    await expect.poll(async () => (await sentFrames(page)).join('')).toContain('pw=');
    const frames = await sentFrames(page);
    const password = announcementPassword(frames);
    expect(password).toBeTruthy();
    const announcement = parseFrames(frames).find((frame) => frame.metadata.has('pw'));
    expect(Buffer.from(announcement.metadata.get('name'), 'base64').toString('utf8')).toBe('Paste event');
    expect(Buffer.from(announcement.payload, 'base64').toString('utf8').split(' ')).toContain('image/png');

    await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
    await emit(page, '\x1b]5522;type=read:pw=' + b64(password) + ';' + b64('image/png') + '\x1b\\');
    await expect.poll(async () => (await sentFrames(page)).join('')).toContain('status=DONE');
    const replies = parseFrames(await sentFrames(page));
    expect(replies[0].metadata.get('status')).toBe('OK');
    const chunks = replies.filter((frame) => frame.metadata.get('status') === 'DATA');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.from(chunk.metadata.get('mime'), 'base64').toString('utf8')).toBe('image/png');
      expect(decodeBase64(chunk.payload).length).toBeLessThanOrEqual(4096);
    }
    const received = Buffer.concat(chunks.map((chunk) => decodeBase64(chunk.payload)));
    expect(received.length).toBe(bytes.length);
    expect(sha256Hex(received)).toBe(expectedSha);
    expect(replies[replies.length - 1].metadata.get('status')).toBe('DONE');

    // The image path used no secure-context API and left no upload/chooser.
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe('undefined');
    expect(requests).toEqual([]);
    expect(fileChoosers).toEqual([]);

    test.info().annotations.push({
      type: 'evidence',
      description: 'exact SHA ' + sha + ' on insecure origin ' + origin.origin + ' ' +
        '(isSecureContext=false, no navigator.clipboard): 5000 image/png bytes pasted into an ' +
        'OSC 5522-enabled TUI were announced with a one-time pw, requested by MIME, and received ' +
        'as ' + chunks.length + ' DATA packets with SHA-256 ' + expectedSha + ' equal to the ' +
        'source; no navigator.clipboard.read, no non-GET request, no file chooser',
    });
  } finally {
    await origin.close();
  }
});
