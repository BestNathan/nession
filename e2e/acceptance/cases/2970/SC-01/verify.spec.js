'use strict';
// #2970 SC-01: while a save for Session A is in flight, moving the mounted
// Workspace to Session B must not let A's answer change B's draft, edit mode,
// notice or revision. A's success still updates A's metadata cache.
//
// The fixture's ownership route moves the selected Session in place through
// the same `useSyncExternalStore` selection the real Workspace uses, so the
// capability view and its editor observe a changed `session` prop without
// remounting. A page-side marker on the metadata section proves the instance
// really survives the switch.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SESSION_A = 'devbox-01:fix-terminal-reconnect';
const SESSION_B = 'devbox-01:design-system';
const ROUTE = '/#/fixture/workspace?capability=session&sessionMetadata=ownership-save';

test('SC-01: a save for A cannot touch B after an in-place Session switch', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.goto(ROUTE);
  await expect(page.getByTestId('session-details')).toBeVisible();
  await expect(page.getByTestId('session-details')).toContainText(SESSION_A);
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');

  // A remount would replace this node (and drop the marker).
  await page.getByTestId('session-metadata').evaluate((node) => {
    node.dataset.ownershipMarker = 'kept';
  });

  await page.getByTestId('session-metadata-edit').click();
  await page.getByTestId('session-metadata-title-input').fill('Saved A title');
  await page.getByTestId('session-metadata-save').click();

  // The fixture holds A's update answer until the Case releases it.
  await expect.poll(() => page.evaluate(() => window.fixtureSessionMetadata?.saves())).toBe(1);
  expect(await page.evaluate(() => window.fixtureSessionMetadata.selected())).toBe(SESSION_A);

  // Move the same mounted Workspace from A to B while A's save is pending.
  await page.evaluate((id) => window.fixtureSessionMetadata.select(id), SESSION_B);
  await expect(page.getByTestId('session-details')).toContainText(SESSION_B);
  await expect(page.getByTestId('session-title')).toHaveText('Design system audit');
  await expect(page.getByTestId('session-metadata-edit')).toBeVisible();
  await expect(page.getByTestId('session-metadata')).toHaveAttribute(
    'data-ownership-marker',
    'kept',
  );

  // B's editor owns its own draft.
  await page.getByTestId('session-metadata-edit').click();
  await page.getByTestId('session-metadata-title-input').fill('B draft');
  await expect(page.getByTestId('session-metadata-title-input')).toHaveValue('B draft');

  // Settle A while B is the mounted editor.
  await page.evaluate(() => window.fixtureSessionMetadata.releaseSave());

  // A's answer must not close B's editor, replace B's draft, or show A's
  // success notice under B.
  await expect(page.getByTestId('session-metadata-title-input')).toHaveValue('B draft');
  await expect(page.getByTestId('session-metadata-editor')).toBeVisible();
  await expect(page.getByTestId('session-metadata-notice')).toHaveCount(0);
  await expect(page.getByTestId('session-title')).toHaveText('Design system audit');
  await expect(page.getByTestId('session-metadata')).toHaveAttribute(
    'data-ownership-marker',
    'kept',
  );

  // A's successful result updated only A's cache.
  await page.evaluate((id) => window.fixtureSessionMetadata.select(id), SESSION_A);
  await expect(page.getByTestId('session-details')).toContainText(SESSION_A);
  await expect(page.getByTestId('session-title')).toHaveText('Saved A title');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': Session A saved with the fixture answer held; an in-place switch to ' +
      SESSION_B + ' preserved the metadata section DOM node (marker kept), B edited its own draft, ' +
      'and releasing A left B\'s draft/editor/notice/title untouched; switching back to A showed ' +
      'A\'s saved title from A\'s cache',
  });
});
