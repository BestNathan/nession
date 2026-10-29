'use strict';
// #2598 SC-08: a TUI that never enabled OSC 5522 gets no image bytes — no
// injection, upload, path or false attachment — and the user sees one honest
// sentence while ordinary text paste still works.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, dispatchPaste,
} = require('../../../shared/terminal-clipboard-cases.cjs');

test('SC-08: unnegotiated image-only paste is refused truthfully; text paste still works', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-08');
  await openClipboardFixture(page);

  // Explicitly off (DECRST 5522).
  await emit(page, '\x1b[?5522l');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });

  const paste = await dispatchPaste(page, {
    images: [{ mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 0, 1, 2]) }],
  });
  expect(paste.delivered).toBe(true);
  expect(paste.defaultPrevented).toBe(true);
  await expect.poll(async () => sentFrames(page)).toEqual([]);
  const notice = page.getByTestId('terminal-clipboard-notice');
  await expect(notice).toHaveAttribute('data-clipboard-notice', 'unsupported-image-paste');
  await expect(notice).toContainText('Image clipboard protocol not supported by this TUI');
  // No permanent control and no file input appeared.
  expect(await page.locator('input[type="file"]').count()).toBe(0);
  expect(await page.getByRole('button', { name: /upload|attach/i }).count()).toBe(0);

  // Text paste is untouched by the refusal.
  await emit(page, '\x1b[?2004h');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  await dispatchPaste(page, { text: 'text still works' });
  await expect.poll(async () => sentFrames(page), { timeout: 5_000 })
    .toEqual(['\x1b[200~text still works\x1b[201~']);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': an image-only paste with mode 5522 off sent zero PTY ' +
      'bytes and showed [Image clipboard protocol not supported by this TUI]; a text paste ' +
      'then produced [200~text still works[201~]',
  });
});
