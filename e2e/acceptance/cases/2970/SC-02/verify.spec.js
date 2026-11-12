'use strict';
// #2970 SC-02: while a forced reload for Session A is in flight, moving the
// mounted Workspace to Session B must not replace B's editor state; the
// same-Session conflict/reload flow still works when no switch happens.
//
// The first half is the negative control on the existing `conflict` route: the
// draft survives the conflict and the forced reload replaces the view. The
// second half defers A's forced read on the fixture's ownership route, moves to
// B, and proves A's answer lands only in A's cache.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SESSION_A = 'devbox-01:fix-terminal-reconnect';
const SESSION_B = 'devbox-01:design-system';
const REMOTE_TITLE = 'Terminal reconnect — updated elsewhere';

test('SC-02: a forced reload for A cannot replace B after a Session switch', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-02');

  // ---- Same-Session conflict/reload remains intact (no switch) ----
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=conflict');
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');
  await page.getByTestId('session-metadata-edit').click();
  await page.getByTestId('session-metadata-title-input').fill('Same-session draft');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-conflict')).toContainText(
    'Your draft is still here',
  );
  await expect(page.getByTestId('session-metadata-title-input')).toHaveValue(
    'Same-session draft',
  );
  await page.getByTestId('session-metadata-reload').click();
  await expect(page.getByTestId('session-title')).toHaveText(REMOTE_TITLE);
  await expect(page.getByTestId('session-metadata-editor')).toHaveCount(0);
  await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);

  // ---- In-flight forced reload + Session switch ----
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=ownership-reload');
  await expect(page.getByTestId('session-details')).toContainText(SESSION_A);
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');

  await page.getByTestId('session-metadata').evaluate((node) => {
    node.dataset.ownershipMarker = 'kept';
  });

  await page.getByTestId('session-metadata-edit').click();
  await page.getByTestId('session-metadata-title-input').fill('Stale A draft');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-conflict')).toBeVisible();

  // The next forced read is A's; hold it, start it, then move to B.
  await page.evaluate(() => window.fixtureSessionMetadata.holdNextRead());
  await page.getByTestId('session-metadata-reload').click();
  await expect.poll(() => page.evaluate(() => window.fixtureSessionMetadata.heldRead())).toBe(true);

  await page.evaluate((id) => window.fixtureSessionMetadata.select(id), SESSION_B);
  await expect(page.getByTestId('session-details')).toContainText(SESSION_B);
  await expect(page.getByTestId('session-title')).toHaveText('Design system audit');
  await expect(page.getByTestId('session-metadata-edit')).toBeVisible();
  await expect(page.getByTestId('session-metadata')).toHaveAttribute(
    'data-ownership-marker',
    'kept',
  );

  await page.getByTestId('session-metadata-edit').click();
  await page.getByTestId('session-metadata-title-input').fill('B draft');
  await expect(page.getByTestId('session-metadata-title-input')).toHaveValue('B draft');

  // Settle A's forced reload while B is the mounted editor.
  await page.evaluate(() => window.fixtureSessionMetadata.releaseRead());

  await expect(page.getByTestId('session-metadata-title-input')).toHaveValue('B draft');
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();
  await expect(page.getByTestId('session-metadata-notice')).toHaveCount(0);
  await expect(page.getByTestId('session-title')).toHaveText('Design system audit');

  // The reload's answer still updated A's cache; only A's view shows it.
  await page.evaluate((id) => window.fixtureSessionMetadata.select(id), SESSION_A);
  await expect(page.getByTestId('session-details')).toContainText(SESSION_A);
  await expect(page.getByTestId('session-title')).toHaveText(REMOTE_TITLE);
  await expect(page.getByTestId('session-metadata-editor')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': on the conflict route a same-Session draft survived the conflict and ' +
      'the forced reload replaced the view with the remote revision; on the ownership route A\'s ' +
      'held forced read was released after an in-place switch to ' + SESSION_B + ', which kept its ' +
      'DOM instance marker, editor, draft and notice; switching back showed the reloaded remote ' +
      'title only under A',
  });
});
