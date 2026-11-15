'use strict';
// #3424 SC-01: with the browser transport unchanged and the same Session
// selected, killing and recreating the durable instance under the same name must
// replace the displayed metadata with the new instance's empty context. The
// fixture reports the same public `session_id` under a new durable instance
// through the production metadata owner; no page reload or reconnect happens.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';
const OLD_TITLE = 'Terminal reconnect reliability';
const TMUX_NAME = 'fix-terminal-reconnect';
const ROUTE = '/#/fixture/workspace?capability=session&sessionMetadata=incarnation';

test('SC-01: a same-name replacement replaces the displayed metadata in place', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ROUTE);

  const details = page.getByTestId('session-details');
  await expect(details).toContainText(SELECTED_ID);
  await expect(page.getByTestId('session-title')).toHaveText(OLD_TITLE);

  // The authoritative list now reports the same public id under a new durable
  // tmux instance; the previous instance's metadata is gone.
  await page.evaluate(
    (id) => window.fixtureSessionMetadata.replaceIncarnation(id),
    SELECTED_ID,
  );

  // No reload, no socket replacement: the details view stops showing the old
  // context and settles on the new instance's empty metadata.
  await expect(page.getByTestId('session-title')).toHaveText(TMUX_NAME);
  await expect(page.getByTestId('session-metadata-description-empty')).toContainText(
    'no saved details yet',
  );
  await expect(details).not.toContainText(OLD_TITLE);
  await expect(page.getByTestId('session-metadata-loading')).toHaveCount(0);

  // A save based on the new instance's revision 0 is accepted, proving the
  // displayed context belongs to the replacement rather than a stale cache.
  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill('Replacement context');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText(
    'Session ID are unchanged',
  );
  await expect(page.getByTestId('session-title')).toHaveText('Replacement context');
  await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: ' + SELECTED_ID + ' first showed "' +
      OLD_TITLE + '"; the same public id was then reported under a new durable tmux ' +
      'instance, after which the unchanged transport and selection showed the session name "' +
      TMUX_NAME + '" and the new instance\'s empty metadata, no previous title remained, ' +
      'and a revision-0 save succeeded without a conflict',
  });
});
