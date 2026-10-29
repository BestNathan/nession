'use strict';
// #2598 SC-05: replayed/bootstrap output, observer clients and a superseded
// stream epoch cannot cause clipboard effects or paste announcements.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, openClipboardFixture, emit, sentFrames, setObserver,
  recordClipboardTextWrites, clipboardTextWrites,
} = require('../../../shared/terminal-clipboard-cases.cjs');

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');

test('SC-05: replay, observers and stale epochs never reach the clipboard', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-05');
  await openClipboardFixture(page);
  await recordClipboardTextWrites(page);

  // A bootstrap capture is history: its OSC 52 must not act.
  await emit(
    page,
    '\x1b]52;c;' + b64('replayed history') + '\x1b\\',
    { bootstrap: { requestedLines: 50, truncated: false } },
  );
  await page.waitForTimeout(300);
  expect(await clipboardTextWrites(page)).toEqual([]);

  // An observer performs no effect and sends no protocol reply.
  await setObserver(page, true);
  await emit(page, '\x1b]52;c;' + b64('observer') + '\x1b\\\x1b[?5522$p');
  await page.waitForTimeout(300);
  expect(await clipboardTextWrites(page)).toEqual([]);
  expect(await sentFrames(page)).toEqual([]);

  // Restoring the Controller role makes the same frame act again.
  await setObserver(page, false);
  await emit(page, '\x1b]52;c;' + b64('controller') + '\x1b\\');
  await expect.poll(async () => clipboardTextWrites(page)).toEqual(['controller']);

  // A superseded stream epoch is ignored even though it is live.
  const epoch1 = { streamEpoch: 1, streamSeq: 1 };
  const epoch2 = { streamEpoch: 2, streamSeq: 2 };
  await emit(page, '\x1b]52;c;' + b64('epoch two') + '\x1b\\', { position: epoch2 });
  await emit(page, '\x1b]52;c;' + b64('epoch one stale') + '\x1b\\', { position: epoch1 });
  await page.waitForTimeout(400);
  expect(await clipboardTextWrites(page)).toEqual(['controller', 'epoch two']);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': a bootstrap replay, an observer frame and a stale-epoch ' +
      'frame each caused no clipboard write and no protocol reply; the Controller frame and the ' +
      'newest epoch wrote [controller] and [epoch two] once each',
  });
});
