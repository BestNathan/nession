'use strict';
// #3319 SC-02: the write fence is per Session and only a successful write
// owns it. A pending read for A neither blocks nor is fenced by a save of B;
// a conflicted save leaves the displayed revision where it was, while a fresh
// read can still replace the cache with the Agent's newer revision.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SESSION_A = 'devbox-01:fix-terminal-reconnect';
const SESSION_B = 'devbox-01:design-system';
const A_TITLE = 'Terminal reconnect reliability';
const B_TITLE = 'Design system audit';
const B_SAVED = 'B saved while A was read';
const B_SAVED_TWICE = 'B saved twice';
const REMOTE_TITLE = 'Terminal reconnect — updated elsewhere';

test('SC-02: per-Session ordering and refused saves keep revisions truthful', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-02');

  // ---- A pending read for A does not block B, and B's save does not fence it ----
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=late-read');
  await expect(page.getByTestId('session-details')).toContainText(SESSION_A);
  await expect(page.getByTestId('session-title')).toHaveText(A_TITLE);

  await page.evaluate(() => window.fixtureSessionMetadata.holdNextRead());
  await page.evaluate((id) => window.fixtureSessionMetadata.read(id), SESSION_A);
  await expect.poll(() => page.evaluate(() => window.fixtureSessionMetadata.heldRead())).toBe(true);

  // Move the in-place Workspace to B while A's read is still pending.
  await page.evaluate((id) => window.fixtureSessionMetadata.select(id), SESSION_B);
  await expect(page.getByTestId('session-details')).toContainText(SESSION_B);
  await expect(page.getByTestId('session-title')).toHaveText(B_TITLE);

  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill(B_SAVED);
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText(
    'Session ID are unchanged',
  );
  await expect(page.getByTestId('session-title')).toHaveText(B_SAVED);

  // Releasing A's answer settles A's cache; B's projection is untouched.
  await page.evaluate(() => window.fixtureSessionMetadata.releaseRead());
  await expect(page.getByTestId('session-title')).toHaveText(B_SAVED);

  // B's displayed revision is still the saved one: a second save succeeds
  // instead of conflicting with the Agent's revision.
  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill(B_SAVED_TWICE);
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-title')).toHaveText(B_SAVED_TWICE);
  await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);

  // A's read was not fenced by B's save: switching back shows the released
  // answer rather than the read's indefinite loading state.
  await page.evaluate((id) => window.fixtureSessionMetadata.select(id), SESSION_A);
  await expect(page.getByTestId('session-details')).toContainText(SESSION_A);
  await expect(page.getByTestId('session-title')).toHaveText(A_TITLE);
  await expect(page.getByTestId('session-metadata-loading')).toHaveCount(0);

  // ---- a refused save does not advance the displayed revision ----
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=conflict');
  await expect(page.getByTestId('session-title')).toHaveText(A_TITLE);

  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill('Conflicted draft');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-conflict')).toContainText(
    'Your draft is still here',
  );

  // The refused write revealed a remote revision but did not publish it: the
  // cache and the draft keep the revision the editor actually read.
  await expect(page.getByTestId('session-title')).toHaveText(A_TITLE);
  await expect(page.getByLabel('Title')).toHaveValue('Conflicted draft');
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();

  // A fresh read is still allowed to replace the cache with the newer answer.
  await page.getByTestId('session-metadata-reload').click();
  await expect(page.getByTestId('session-title')).toHaveText(REMOTE_TITLE);
  await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);
  await expect(page.getByTestId('session-metadata-editor')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: with a forced read for ' + SESSION_A +
      ' held, the Workspace moved to ' + SESSION_B + ', which saved "' + B_SAVED +
      '" and then "' + B_SAVED_TWICE + '" without a conflict; releasing A\'s held answer left ' +
      'B\'s title unchanged and settled A back to its loaded details without a loading state; ' +
      'on the conflict route the refused save kept the loaded title and the typed draft, and ' +
      'the explicit reload then showed the remote revision "' + REMOTE_TITLE + '"',
  });
});
