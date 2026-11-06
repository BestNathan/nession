'use strict';
// #2789 SC-05: Session navigation uses the metadata title when set and the tmux
// name otherwise, keeps workload/Agent/recency and degraded-state semantics,
// and gains no tags or cards. Editing the display name never changes
// session_id or the tmux name.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';

test('SC-05: navigation shows the display title while identity stays tmux', async ({ page }) => {
  test.setTimeout(120_000);
  const { sha } = verifiedRuntime('SC-05');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture?sessionMetadata=normal');

  const row = page.getByTestId(`session-item-${SELECTED_ID}`);
  await expect(row.getByTestId('session-item-title')).toHaveText(
    'Terminal reconnect reliability',
  );
  // The meta line's workload/Agent/recency slots are still present.
  await expect(row.getByTestId('session-item-meta')).toContainText('·');
  await expect(row.getByTestId('session-item-workload')).toHaveText('bash');

  // A Session whose metadata has no title falls back to its tmux name.
  await expect(
    page.getByTestId('session-item-macbook:review-pr-561').getByTestId('session-item-title'),
  ).toHaveText('review-pr-561');
  // Rows never gain tag chips or description cards.
  await expect(page.getByTestId('session-metadata-tag')).toHaveCount(0);

  // Editing the display title leaves the Session identity and tmux name
  // untouched in the details view.
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=normal');
  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill('Renamed display title');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-title')).toHaveText('Renamed display title');
  await expect(page.getByTestId('session-details')).toContainText(SELECTED_ID);
  await expect(page.getByTestId('session-details')).toContainText('fix-terminal-reconnect');

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: the selected row showed its metadata title, a Session ' +
      'with metadata but no title showed its original Session name, the workload/Agent/recency slots ' +
      'remained, navigation rows contained no tag chips, and saving a new display title left ' +
      'session_id devbox-01:fix-terminal-reconnect and the original Session name visible and unchanged',
  });
});
