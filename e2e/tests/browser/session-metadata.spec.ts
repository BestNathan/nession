// e2e/tests/browser/session-metadata.spec.ts
//
// #2789 — Session metadata is Session-owned work context, separate from the
// tmux name and the Session identity. These cases drive the production
// `SessionDetails` / `SessionList` components against the fixture's canned
// Agent store, so the Web and App experiences are proven on the real DOM.
//
// Local runs are forbidden for the same reason as fixture-app.spec.ts: the
// e2e webServer stack operates tmux. CI-only.
import { expect, test } from '@playwright/test';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const SELECTED_ID = 'devbox-01:fix-terminal-reconnect';

test.describe('Web', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('reads, edits, saves and cancels Session metadata in Workspace', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=normal');

    await expect(page.getByTestId('session-details')).toBeVisible();
    await expect(page.getByTestId('session-title')).toHaveText(
      'Terminal reconnect reliability',
    );
    // The display title never replaces the Session identity.
    await expect(page.getByTestId('session-details')).toContainText(SELECTED_ID);

    await page.getByTestId('session-metadata-edit').click();
    const title = page.getByLabel('Title');
    await expect(title).toHaveValue('Terminal reconnect reliability');
    await title.fill('Reconnect hardening');
    await page.getByLabel('Description').fill('Verify the control-mode recovery path.');

    // Keyboard entry: Enter commits a tag.
    const tagEntry = page.getByLabel('Add tag');
    await tagEntry.fill('recovery');
    await tagEntry.press('Enter');
    await expect(page.getByTestId('session-metadata-tags-editor')).toContainText('#recovery');

    await page.getByTestId('session-metadata-save').click();
    await expect(page.getByTestId('session-metadata-notice')).toContainText(
      'Session ID is unchanged',
    );
    await expect(page.getByTestId('session-title')).toHaveText('Reconnect hardening');
    await expect(page.getByTestId('session-metadata-tags-view')).toContainText('#recovery');
    await expect(page.getByTestId('session-details')).toContainText(SELECTED_ID);

    // Cancel discards the draft and restores the saved view.
    await page.getByTestId('session-metadata-edit').click();
    await page.getByLabel('Title').fill('Discarded draft');
    await page.getByTestId('session-metadata-cancel').click();
    await expect(page.getByTestId('session-title')).toHaveText('Reconnect hardening');
    await expect(page.getByTestId('session-metadata-notice')).toHaveCount(0);
  });

  test('legacy and metadata titles drive Session navigation', async ({ page }) => {
    await page.goto('/#/fixture?sessionMetadata=normal');

    const row = page.getByTestId(`session-item-${SELECTED_ID}`);
    await expect(row.getByTestId('session-item-title')).toHaveText(
      'Terminal reconnect reliability',
    );
    // A Session without metadata keeps its tmux name.
    await expect(
      page.getByTestId('session-item-macbook:review-pr-561').getByTestId('session-item-title'),
    ).toHaveText('review-pr-561');
    // Tags stay out of navigation rows.
    await expect(page.getByTestId('session-metadata-tag')).toHaveCount(0);

    await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=legacy');
    await expect(page.getByTestId('session-title')).toHaveText('fix-terminal-reconnect');
    await expect(page.getByTestId('session-metadata-description-empty')).toContainText(
      'no saved details yet',
    );

    await page.getByTestId('session-metadata-edit').click();
    await page.getByLabel('Title').fill('First saved title');
    await page.getByTestId('session-metadata-save').click();
    await expect(page.getByTestId('session-title')).toHaveText('First saved title');
  });

  test('a revision conflict keeps the draft until the user discards it', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=conflict');

    await expect(page.getByTestId('session-title')).toHaveText(
      'Terminal reconnect reliability',
    );
    await page.getByTestId('session-metadata-edit').click();
    await page.getByLabel('Title').fill('My unsaved draft');
    await page.getByTestId('session-metadata-save').click();

    const conflict = page.getByTestId('session-metadata-conflict');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('Your draft is still here');
    await expect(page.getByLabel('Title')).toHaveValue('My unsaved draft');

    await page.getByTestId('session-metadata-reload').click();
    await expect(page.getByTestId('session-title')).toHaveText(
      'Terminal reconnect — updated elsewhere',
    );
    await expect(page.getByTestId('session-metadata-conflict')).toHaveCount(0);
    await expect(page.getByTestId('session-metadata-editor')).toHaveCount(0);
  });

  test('an unreachable Agent reports the failure instead of a save', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=session&sessionMetadata=offline');

    await expect(page.getByTestId('session-metadata-error')).toContainText('Agent is offline');
    await expect(page.getByTestId('session-metadata-edit')).toHaveCount(0);
    await expect(page.getByTestId('session-title')).toHaveText('fix-terminal-reconnect');

    await page.getByTestId('session-metadata-retry').click();
    await expect(page.getByTestId('session-metadata-error')).toContainText('Agent is offline');
  });
});

test.describe('App', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('edits metadata at Workspace depth with a reachable leave', async ({ page }) => {
    await page.goto('/#/fixture/app?sessionMetadata=normal');
    await page.getByTestId('app-header-workspace').click();
    await page.getByTestId('workspace-tool-session').click();

    await expect(page.getByTestId('session-details-app')).toBeVisible();
    await expect(page.getByTestId('session-title')).toHaveText(
      'Terminal reconnect reliability',
    );

    await page.getByTestId('session-metadata-edit').click();
    // The editor scrolls inside the App's bounded Workspace scroller; the
    // navigation bar stays outside it and remains reachable.
    const save = page.getByTestId('session-metadata-save');
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await expect(page.getByTestId('app-page-header')).toBeVisible();

    await page.getByLabel('Title').fill('App edited title');
    await save.tap();
    await expect(page.getByTestId('session-title')).toHaveText('App edited title');

    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);
  });
});
