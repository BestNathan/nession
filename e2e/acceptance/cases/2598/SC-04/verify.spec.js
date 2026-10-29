'use strict';
// #2598 SC-04: a browser-denied clipboard write or read returns the protocol's
// truthful error and a minimal UI state; a real user gesture completes the
// permitted copy. Nothing claims an async Clipboard API call succeeded when it
// did not.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, parseFrames, readClipboardText,
} = require('../../../shared/terminal-clipboard-cases.cjs');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-04: denied effects are truthful and an explicit gesture completes the copy', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-04');
  await openClipboardFixture(page);

  // Block the async text write: the surface offers the user-gesture copy and
  // does not claim success.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    window.__restoreWriteText = () => { clipboard.writeText = original; };
    clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await emit(page, '\x1b]52;c;' + b64('gesture payload') + '\x1b\\');
  const notice = page.getByTestId('terminal-clipboard-notice');
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'copy-required');
  await expect(notice).toContainText('The terminal wants to copy to your clipboard.');

  // The user gesture is the authority the blocked call lacked.
  await page.evaluate(() => { window.__restoreWriteText(); });
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(notice).toHaveCount(0);
  expect(await readClipboardText(page)).toBe('gesture payload');

  // A denied OSC 5522 write replies EPERM and states it; nothing is written.
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.write.bind(clipboard);
    window.__restoreWrite = () => { clipboard.write = original; };
    clipboard.write = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await emit(page, '\x1b]5522;type=write:id=denied\x1b\\');
  await emit(page, '\x1b]5522;type=wdata:mime=' + b64('text/plain') + ';' + b64('denied payload') + '\x1b\\');
  await emit(page, '\x1b]5522;type=wdata\x1b\\');
  await expect.poll(async () => (await sentFrames(page)).join('')).toContain('status=EPERM:id=denied');
  await expect(page.getByTestId('terminal-clipboard-notice'))
    .toHaveAttribute('data-clipboard-notice', 'write-denied');
  await page.evaluate(() => { window.__restoreWrite(); });

  // A remote read without the one-time password is EPERM — no data packet.
  const before = (await sentFrames(page)).length;
  await emit(page, '\x1b]5522;type=read;' + b64('text/plain') + '\x1b\\');
  await expect.poll(async () => (await sentFrames(page)).length, { timeout: 5_000 })
    .toBeGreaterThan(before);
  const replies = parseFrames((await sentFrames(page)).slice(before));
  expect(replies).toHaveLength(1);
  expect(replies[0].metadata.get('status')).toBe('EPERM');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': blocked OSC 52 write showed copy-required and the Copy ' +
      'gesture wrote [gesture payload] (read back); blocked OSC 5522 write replied ' +
      'EPERM:id=denied with the write-denied notice; a spontaneous read replied EPERM with no ' +
      'DATA packet',
  });
});
