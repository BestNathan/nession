'use strict';
// #3424 SC-02: a metadata read started for the old incarnation must not restore
// old context after the replacement is observed; a fresh read for the new
// incarnation succeeds. An ordinary list refresh for the same incarnation must
// keep both the loaded metadata and an active edit draft.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';
const OLD_TITLE = 'Terminal reconnect reliability';
const TMUX_NAME = 'fix-terminal-reconnect';
const ROUTE = '/#/fixture/workspace?capability=session&sessionMetadata=incarnation';

test('SC-02: an old-instance read cannot restore context after replacement', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-02');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ROUTE);
  await expect(page.getByTestId('session-title')).toHaveText(OLD_TITLE);

  // A forced read for the old incarnation is answered with the old metadata
  // but held until after the replacement is observed.
  await page.evaluate(() => window.fixtureSessionMetadata.holdNextRead());
  await page.evaluate((id) => window.fixtureSessionMetadata.read(id), SELECTED_ID);
  await expect.poll(() => page.evaluate(() => window.fixtureSessionMetadata.heldRead())).toBe(true);

  await page.evaluate(
    (id) => window.fixtureSessionMetadata.replaceIncarnation(id),
    SELECTED_ID,
  );

  // The replacement's own read starts at revision 0 and resolves empty.
  await expect(page.getByTestId('session-title')).toHaveText(TMUX_NAME);
  await expect(page.getByTestId('session-metadata-description-empty')).toContainText(
    'no saved details yet',
  );

  // The held old-instance answer now resolves. It was started before the
  // replacement, so it must not restore the previous title or linger in
  // loading.
  await page.evaluate(() => window.fixtureSessionMetadata.releaseRead());

  await expect(page.getByTestId('session-title')).toHaveText(TMUX_NAME);
  await expect(page.getByTestId('session-details')).not.toContainText(OLD_TITLE);
  await expect(page.getByTestId('session-metadata-loading')).toHaveCount(0);

  // A fresh read for the new incarnation succeeds: the editor's base revision
  // is 0 and a save is accepted without a conflict.
  await page.getByTestId('session-metadata-edit').click();
  await expect(page.getByLabel('Title')).toHaveValue('');
  await page.getByLabel('Title').fill('After replacement');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText(
    'Session ID are unchanged',
  );
  await expect(page.getByTestId('session-title')).toHaveText('After replacement');
  await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);

  // Negative control: an ordinary refresh of the SAME incarnation is not an
  // invalidation. An active draft and the loaded metadata stay put.
  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill('Unsaved draft');
  await page.evaluate((id) => window.fixtureSessionMetadata.refresh(id), SELECTED_ID);
  await expect(page.getByLabel('Title')).toHaveValue('Unsaved draft');
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();
  await page.getByTestId('session-metadata-cancel').click();
  await expect(page.getByTestId('session-title')).toHaveText('After replacement');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: a forced metadata read for the old ' +
      'incarnation of ' + SELECTED_ID + ' was held with its old answer while the same ' +
      'public id was reported under a new durable instance; the new read resolved at ' +
      'revision 0, releasing the old answer left the session name "' + TMUX_NAME +
      '" and no loading state, a revision-0 save succeeded, and an ordinary refresh of ' +
      'the same incarnation preserved an active draft',
  });
});
