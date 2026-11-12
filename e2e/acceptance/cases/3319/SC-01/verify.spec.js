'use strict';
// #3319 SC-01: a forced metadata read that was already in flight when a save
// succeeded must never replace the saved revision. The fixture's `late-read`
// route holds a read's pre-save answer while the real editor saves through the
// production cache owner; releasing the answer must leave the shared cache —
// and every rendered projection of it — on the saved revision.
//
// The route's sidebar row and its Edit details dialog read the same cache
// entry, so the Case asserts both the navigation title and Session details.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';
const SAVED_TITLE = 'After the save';
const SECOND_TITLE = 'After the second save';
const DESCRIPTION = 'Saved while the older read was pending.';
const ROUTE = '/#/fixture?sessionMetadata=late-read';

test('SC-01: a read pending before a successful save cannot roll the cache back', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-01');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ROUTE);

  const row = page.getByTestId(`session-item-${SELECTED_ID}`);
  await expect(row.getByTestId('session-item-title')).toHaveText(
    'Terminal reconnect reliability',
  );

  // The details surface on this route is the row's Edit details dialog; the
  // sidebar row behind it stays subscribed to the same cache entry.
  await page.getByTestId(`session-actions-${SELECTED_ID}`).click();
  await page.getByTestId(`session-actions-edit-${SELECTED_ID}`).click();
  const dialog = page.getByTestId('session-details-dialog');
  await expect(dialog).toBeVisible();

  await page.getByLabel('Title').fill(SAVED_TITLE);
  await page.getByLabel('Description').fill(DESCRIPTION);
  const tagEntry = page.getByLabel('Add tag');
  await tagEntry.fill('ordered');
  await tagEntry.press('Enter');
  await expect(page.getByTestId('session-metadata-tags-editor')).toContainText('#ordered');

  // A reconnect-style forced read starts before the save; the fixture captures
  // its revision-4 answer and holds it until the Case releases it.
  await page.evaluate(() => window.fixtureSessionMetadata.holdNextRead());
  await page.evaluate((id) => window.fixtureSessionMetadata.read(id), SELECTED_ID);
  await expect.poll(() => page.evaluate(() => window.fixtureSessionMetadata.heldRead())).toBe(true);

  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText(
    'Session ID are unchanged',
  );
  await expect(page.getByTestId('session-title')).toHaveText(SAVED_TITLE);
  await expect(row.getByTestId('session-item-title')).toHaveText(SAVED_TITLE);

  // The pre-save read now resolves. It must not replace the saved revision in
  // the cache, the dialog, or the navigation row, and it must not leave the
  // details view stuck on its loading state.
  await page.evaluate(() => window.fixtureSessionMetadata.releaseRead());

  await expect(page.getByTestId('session-title')).toHaveText(SAVED_TITLE);
  await expect(row.getByTestId('session-item-title')).toHaveText(SAVED_TITLE);
  await expect(dialog).toContainText(DESCRIPTION);
  await expect(page.getByTestId('session-metadata-tags-view')).toContainText('#ordered');
  await expect(page.getByTestId('session-metadata-loading')).toHaveCount(0);

  // The displayed revision is the saved one, not the released revision: a
  // second save using the editor's base revision succeeds. A rolled-back
  // revision would make this write conflict with the Agent's newer one.
  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill(SECOND_TITLE);
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText(
    'Session ID are unchanged',
  );
  await expect(page.getByTestId('session-title')).toHaveText(SECOND_TITLE);
  await expect(row.getByTestId('session-item-title')).toHaveText(SECOND_TITLE);
  await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: a forced read for ' + SELECTED_ID +
      ' was held with its pre-save answer while the title, description and tag were saved ' +
      '(revision 5); after releasing the older answer the details dialog, the navigation row ' +
      'and the shared cache still showed "' + SAVED_TITLE + '", no loading state remained, and ' +
      'a second save succeeded rather than conflicting, proving the displayed revision was 5',
  });
});
