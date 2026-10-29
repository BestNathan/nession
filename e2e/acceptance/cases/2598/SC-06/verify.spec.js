'use strict';
// #2598 SC-06: an image-only Web clipboard reaches an OSC 5522-enabled TUI as
// the matching binary bytes through the standard protocol, with SHA-256
// identity and no upload, remote file or path insertion at any point.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, parseFrames, dispatchPaste,
  decodeBase64, sha256Hex, announcementPassword,
} = require('../../../shared/terminal-clipboard-cases.cjs');

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-06: pasted image bytes reach the TUI byte-identically with no upload', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-06');
  await openClipboardFixture(page);

  const requests = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') { requests.push(request.method() + ' ' + request.url()); }
  });
  const fileChoosers = [];
  page.on('filechooser', (chooser) => { fileChoosers.push(chooser); });

  // A PNG-shaped payload with every byte value in a deterministic order.
  const bytes = Buffer.alloc(5000);
  for (let index = 0; index < bytes.length; index += 1) { bytes[index] = (index * 31) % 256; }
  const expectedSha = sha256Hex(bytes);

  await emit(page, '\x1b[?5522h');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  const paste = await dispatchPaste(page, { images: [{ mime: 'image/png', bytes }] });
  expect(paste.delivered).toBe(true);
  expect(paste.defaultPrevented).toBe(true);

  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('pw=');
  const frames = await sentFrames(page);
  const password = announcementPassword(frames);
  expect(password).toBeTruthy();
  const announcement = parseFrames(frames).find((frame) => frame.metadata.has('pw'));
  expect(Buffer.from(announcement.metadata.get('name'), 'base64').toString('utf8')).toBe('Paste event');
  const offered = Buffer.from(announcement.payload, 'base64').toString('utf8');
  expect(offered.split(' ')).toContain('image/png');

  // The TUI requests the negotiated MIME with the one-time password.
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

  // No upload/file path was created anywhere: no non-GET request, no chooser.
  expect(requests).toEqual([]);
  expect(fileChoosers).toEqual([]);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': 5000 image/png bytes pasted into an OSC 5522-enabled TUI ' +
      'were announced with a one-time password, requested by MIME, and received as ' + chunks.length +
      ' DATA packets (<=4096 bytes each) with SHA-256 ' + expectedSha + ' equal to the source; ' +
      'no non-GET request and no file chooser occurred',
  });
});
