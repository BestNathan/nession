'use strict';
// #2789 SC-03: the Web Workspace SessionDetails and the App narrow Workspace
// read, edit, save and cancel the same Session metadata with accessible
// controls, bounded scrolling and a reachable return. Failures and conflicts
// neither masquerade as success nor discard the draft.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';

test('SC-03: Web and App edit Session metadata with truthful failure states', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  // ---- Web ----
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=normal');
  await expect(page.getByTestId('session-details')).toBeVisible();
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');

  await page.getByTestId('session-metadata-edit').click();
  const title = page.getByLabel('Title');
  await expect(title).toHaveValue('Terminal reconnect reliability');
  await title.fill('Reconnect hardening');
  await page.getByLabel('Description').fill('Verify the control-mode recovery path.');
  const tagEntry = page.getByLabel('Add tag');
  await tagEntry.fill('recovery');
  await tagEntry.press('Enter');
  await expect(page.getByTestId('session-metadata-tags-editor')).toContainText('#recovery');

  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-notice')).toContainText('Session ID are unchanged');
  await expect(page.getByTestId('session-title')).toHaveText('Reconnect hardening');
  await expect(page.getByTestId('session-details')).toContainText(SELECTED_ID);

  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill('Discarded draft');
  await page.getByTestId('session-metadata-cancel').click();
  await expect(page.getByTestId('session-title')).toHaveText('Reconnect hardening');

  // ---- Web: revision conflict keeps the draft ----
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=conflict');
  await page.getByTestId('session-metadata-edit').click();
  await page.getByLabel('Title').fill('My unsaved draft');
  await page.getByTestId('session-metadata-save').click();
  await expect(page.getByTestId('session-metadata-conflict')).toContainText('Your draft is still here');
  await expect(page.getByLabel('Title')).toHaveValue('My unsaved draft');
  await page.getByTestId('session-metadata-reload').click();
  await expect(page.getByTestId('session-title')).toHaveText(
    'Terminal reconnect — updated elsewhere',
  );

  // ---- Web: unreachable Agent is not a claimed save ----
  await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=offline');
  await expect(page.getByTestId('session-metadata-error')).toContainText('Agent is offline');
  await expect(page.getByTestId('session-metadata-edit')).toHaveCount(0);

  // ---- App: same editor at 390px depth, reachable save and Back ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/app?sessionMetadata=normal');
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-session').click();
  await expect(page.getByTestId('session-details-app')).toBeVisible();
  await expect(page.getByTestId('session-title')).toHaveText('Terminal reconnect reliability');
  await page.getByTestId('session-metadata-edit').click();
  const save = page.getByTestId('session-metadata-save');
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expect(page.getByTestId('app-page-header')).toBeVisible();
  await page.getByLabel('Title').fill('App edited title');
  await save.click();
  await expect(page.getByTestId('session-title')).toHaveText('App edited title');
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900 and 390x844: Web edited/saved/cancelled title, ' +
      'description and a keyboard-entered tag while the Session ID stayed visible; a revision ' +
      'conflict kept the typed draft until the explicit reload; an offline Agent showed its ' +
      'error with no edit action; the App opened the same editor inside a bounded scroller ' +
      'with its header visible, saved and returned to the parent depth via Back',
  });
});
