// e2e/tests/browser/fixture-env.spec.ts
//
// #1202 — Environment as a context-first capability, and #2654 — Session-first
// binding and layout, asserted against real DOM through the fixture's canned
// `server.env.*` backend (fixtureEnv.ts). Every state here emerges from the
// files the fixture serves: the masked row exists because staging.env holds a
// sensitive-looking key, the in-use dialog because prod.env is used by two
// sessions, the skipped-line warning because staging.env has a line with no
// '=', and the binding states because SET/REAPPLY move an in-memory revision.
//
// The assertions are shape-based, not copy-based, except where the criterion
// *is* the copy (the Environment-language empty state, the impact dialog that
// must never say "Force").
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtureApp } from '../../helpers/fixtureVisual';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const STAGING_KEY = 'server::staging.env';
const PROD_KEY = 'agent:devbox-01:prod.env';
const LOCAL_KEY = 'agent:devbox-01:local.env';
const STAGING_ROW = `env-profile-row-${STAGING_KEY}`;
const PROD_ROW = `env-profile-row-${PROD_KEY}`;
const LOCAL_ROW = `env-profile-row-${LOCAL_KEY}`;

async function gotoEnvWorkspace(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=env');
  // The list is what the list answer produces, so waiting for it is what makes
  // everything below about resolved profiles rather than a pending read.
  await page.getByTestId('env-profile-list').waitFor();
}

/** Wait until the default Session surface has its binding answer. */
async function expectSessionOverview(page: Page): Promise<void> {
  await expect(page.getByTestId('env-session-environment')).toBeVisible();
  await expect(page.getByTestId('env-session-status')).toBeVisible();
}

/** Type into the CodeMirror editor that is showing, so the draft goes dirty. */
async function dirtyTheEditor(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  // New line at the doc end — typing straight after the click glues the text
  // onto the last content line.
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('EXTRA=1');
  await expect(page.getByTestId('env-editor-dirty')).toBeVisible();
}

test.describe('Web 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the Session is the default surface and the navigator is its profile index', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);
    await expectSessionOverview(page);

    // The Session's observed state is the standing line; revision telemetry
    // waits behind Details.
    await expect(page.getByTestId('env-session-status')).toHaveAttribute(
      'data-status',
      'in_sync',
    );
    await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');

    // Included is the desired selection, marked as such rather than "Active".
    await expect(page.getByTestId(STAGING_ROW)).toHaveAttribute('data-included', 'true');
    await expect(page.getByTestId(STAGING_ROW)).toContainText('Included');
    await expect(page.getByTestId(PROD_ROW)).not.toContainText('Included');
    await expect(page.getByTestId(STAGING_ROW)).toContainText('Server · 6 vars');
    await expect(page.getByTestId(PROD_ROW)).toContainText('devbox-01 · 4 vars');
    await expect(page.getByTestId(LOCAL_ROW)).toBeVisible();
    await expect(page.getByTestId('env-session-profiles')).toContainText('staging.env');

    // Nothing destructive lives on a row — delete is a Profile Detail depth.
    await expect(
      page.getByTestId('env-navigator').locator('[data-testid*="delete"]'),
    ).toHaveCount(0);
  });

  test('Details discloses revisions, managed keys and the shell', async ({ page }) => {
    await gotoEnvWorkspace(page);
    await expectSessionOverview(page);

    await page.getByTestId('env-session-details').click();
    const details = page.getByTestId('env-session-details-body');
    await expect(details).toBeVisible();
    await expect(details).toContainText('Desired revision');
    await expect(details).toContainText('Applied revision');
    await expect(details).toContainText('Managed keys');
    await expect(details).toContainText('bash');
  });

  test('selecting a profile reads it first — sensitive masked, empty is not masked', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();

    await expect(page.getByTestId('env-profile-detail')).toBeVisible();
    await expect(page.getByTestId('env-profile-included')).toContainText(
      'Included in binding',
    );
    await expect(page.getByTestId('env-profile-session-link')).toContainText(
      'Current Session · In sync',
    );

    // Masked at rest: the bullets render, the secret is nowhere on the page.
    await expect(page.getByTestId('env-var-masked-API_KEY')).toBeVisible();
    await expect(page.getByTestId('env-profile-detail')).not.toContainText(
      'staging-secret-9f2c7d',
    );

    // An empty value says so — masked and empty never look alike.
    await expect(page.getByTestId('env-var-row-EMPTY_OVERRIDE')).toContainText('(empty)');

    // The skipped line is named, not hidden.
    await expect(page.getByTestId('env-var-warnings')).toContainText('1 line skipped');
    await expect(page.getByTestId('env-var-warnings')).toContainText("missing '='");
  });

  test('the profile’s Session link returns to the Session overview', async ({ page }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();
    await page.getByTestId('env-profile-session-link').click();

    await expectSessionOverview(page);
    await expect(page.getByTestId('env-session-details')).toBeVisible();
  });

  test('reveal is per-row and ephemeral', async ({ page }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();
    await expect(page.getByTestId('env-var-masked-API_KEY')).toBeVisible();

    await page.getByTestId('env-var-reveal-API_KEY').click();
    await expect(page.getByTestId('env-var-row-API_KEY')).toContainText('staging-secret-9f2c7d');

    // And hides again — the reveal is a per-row toggle, not a mode.
    await page.getByTestId('env-var-reveal-API_KEY').click();
    await expect(page.getByTestId('env-var-row-API_KEY')).not.toContainText(
      'staging-secret-9f2c7d',
    );
  });

  test('the variable filter appears past its threshold and narrows the rows', async ({ page }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();
    await expect(page.getByTestId('env-var-search')).toBeVisible();

    await page.getByTestId('env-var-search').fill('api');
    await expect(page.getByTestId('env-var-row-API_BASE')).toBeVisible();
    await expect(page.getByTestId('env-var-row-API_KEY')).toBeVisible();
    await expect(page.getByTestId('env-var-row-NODE_ENV')).toHaveCount(0);
  });

  test('Raw is one tab away and read-only at rest', async ({ page }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();

    await page.getByRole('tab', { name: 'Raw' }).click();
    const raw = page.getByTestId('env-raw-view');
    await expect(raw).toBeVisible();
    await expect(raw.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  });

  test('a dirty edit guards the switch to another profile through the Nession dialog', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();
    await page.getByTestId('env-edit').click();
    await dirtyTheEditor(page);

    await page.getByTestId(PROD_ROW).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Discard unsaved changes?');

    await page.getByTestId('env-guard-cancel').click();
    await expect(page.getByTestId('env-profile-editor')).toBeVisible();
  });

  test('saving an in-use profile explains the Session impact, and never says Force', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(PROD_ROW).click();
    await expect(page.getByTestId('env-profile-usage')).toContainText('api-tests');

    await page.getByTestId('env-edit').click();
    await dirtyTheEditor(page);
    await page.getByTestId('env-editor-save').click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Save while used by running sessions?');
    await expect(dialog).toContainText('api-tests, deploy');
    await expect(dialog).not.toContainText(/force/i);
  });

  test('Manage binding opens the ordered draft; Cancel sends nothing', async ({ page }) => {
    await gotoEnvWorkspace(page);
    await expectSessionOverview(page);

    await page.getByTestId('env-manage-binding').click();
    await expect(page.getByTestId('env-binding-draft')).toBeVisible();
    // Nothing has changed yet, so there is nothing to apply.
    await expect(page.getByTestId('env-draft-apply')).toBeDisabled();
    await expect(page.getByTestId(`env-draft-profile-${STAGING_KEY}`)).toBeVisible();

    // Remove the only profile, then cancel: the Session keeps its binding.
    await page.getByTestId(`env-draft-remove-${STAGING_KEY}`).click();
    await expect(page.getByTestId('env-draft-empty')).toBeVisible();
    await page.getByTestId('env-draft-cancel').click();

    await expectSessionOverview(page);
    await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
    await expect(page.getByTestId(`env-session-profile-${STAGING_KEY}`)).toBeVisible();
  });

  test('the draft previews effective keys, overlaps and changed keys, then Apply replaces the whole binding', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);
    await expectSessionOverview(page);

    await page.getByTestId('env-manage-binding').click();
    await page.getByTestId(`env-draft-add-${PROD_KEY}`).click();

    // Counts and names, never values.
    const preview = page.getByTestId('env-draft-preview');
    await expect(preview).toContainText('8 effective variables');
    await expect(preview).toContainText('2 overlapping keys: NODE_ENV, LOG_LEVEL');
    await expect(preview).toContainText(
      'Changed keys: NODE_ENV, LOG_LEVEL, DATABASE_URL, DB_PASSWORD',
    );
    await expect(preview).not.toContainText('staging-secret-9f2c7d');
    await expect(preview).not.toContainText('prod-password-77');

    // Order is the meaning: moving prod ahead of staging makes the overlapping
    // keys fall back to staging's current values, so only prod's own keys
    // remain changed.
    await page.getByTestId(`env-draft-up-${PROD_KEY}`).click();
    await expect(
      page.getByTestId('env-draft-profiles').locator('li').first(),
    ).toContainText('prod.env');
    await expect(preview).toContainText('Changed keys: DATABASE_URL, DB_PASSWORD');

    // Put it back and apply the ordered selection.
    await page.getByTestId(`env-draft-down-${PROD_KEY}`).click();
    await expect(
      page.getByTestId('env-draft-profiles').locator('li').first(),
    ).toContainText('staging.env');
    await page.getByTestId('env-draft-apply').click();

    // The draft is spent; the Session overview tells the truth: the new
    // revision materialized, and the running shell updates at its next prompt.
    await expect(page.getByTestId('env-binding-draft')).toHaveCount(0);
    await expectSessionOverview(page);
    await expect(page.getByTestId('env-session-status')).toHaveAttribute(
      'data-status',
      'pending_shell',
    );
    await expect(page.getByTestId('env-session-status-title')).toHaveText(
      'Waiting for the next shell prompt',
    );
    await expect(page.getByTestId(`env-session-profile-${STAGING_KEY}`)).toBeVisible();
    await expect(page.getByTestId(`env-session-profile-${PROD_KEY}`)).toBeVisible();

    await page.getByTestId('env-session-details').click();
    await expect(page.getByTestId('env-session-details-body')).toContainText(
      'Desired revision',
    );
  });

  test('an unsupported shell is a warning with the Agent’s reason, not a quiet in-sync', async ({
    page,
  }) => {
    await page.goto('/#/fixture/workspace?capability=env&env=unsupported');
    await page.getByTestId('env-profile-list').waitFor();
    await expectSessionOverview(page);

    const status = page.getByTestId('env-session-status');
    await expect(status).toHaveAttribute('data-status', 'unsupported_shell');
    await expect(status).toHaveAttribute('data-tone', 'warning');
    await expect(page.getByTestId('env-session-status-title')).toHaveText(
      'Unsupported shell',
    );
    await expect(page.getByTestId('env-session-status-detail')).toContainText(
      'No Session-local adapter for shell /usr/bin/fish.',
    );
    await expect(page.getByTestId('env-session-status-detail')).toContainText(
      'New panes and processes still inherit the environment.',
    );
  });

  test('an outdated binding is disclosed and Reapply clears it', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env&env=outdated');
    await page.getByTestId('env-profile-list').waitFor();
    await expectSessionOverview(page);

    await expect(page.getByTestId('env-session-outdated')).toBeVisible();
    await expect(page.getByTestId('env-session-outdated')).toContainText(
      'changed since this Session materialized',
    );
    await expect(page.getByTestId('env-session-reapply')).toBeVisible();

    await page.getByTestId('env-session-reapply').click();
    await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
    await expect(page.getByTestId('env-session-outdated')).toHaveCount(0);
  });

  test('a materialization error shows the reason and offers Reapply', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env&env=error');
    await page.getByTestId('env-profile-list').waitFor();
    await expectSessionOverview(page);

    const status = page.getByTestId('env-session-status');
    await expect(status).toHaveAttribute('data-status', 'error');
    await expect(status).toHaveAttribute('data-tone', 'error');
    await expect(page.getByTestId('env-session-status-title')).toHaveText(
      'Environment error',
    );
    await expect(page.getByTestId('env-session-status-detail')).toContainText(
      'permission denied',
    );
    await expect(page.getByTestId('env-session-reapply')).toBeVisible();
  });

  test('an unobserved binding is unavailable, with a Retry rather than a guessed status', async ({
    page,
  }) => {
    await page.goto('/#/fixture/workspace?capability=env&env=unavailable');
    await page.getByTestId('env-profile-list').waitFor();
    await expect(page.getByTestId('env-session-status')).toBeVisible();

    const status = page.getByTestId('env-session-status');
    await expect(status).toHaveAttribute('data-status', 'unavailable');
    await expect(page.getByTestId('env-session-status-title')).toHaveText(
      'Status unavailable',
    );
    await expect(page.getByTestId('env-session-retry')).toBeVisible();
  });

  test('the empty inventory speaks Environment, not files', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env&env=empty');
    await expect(page.getByTestId('env-navigator-empty')).toContainText('No environments yet');
    await expect(page.getByTestId('env-session-status-title')).toHaveText(
      'No environment applied',
    );
  });
});

test.describe('App 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function gotoEnvCapability(page: Page): Promise<void> {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').click();
    // Capsule V2 (#1347) gives every capability with a Workspace view a slot of
    // its own, `available` ones included, so the App reaches Environment by
    // tapping its entry. The picker this walk used to open is gone, and with it
    // the old rule that `available` meant "no direct dock slot".
    await page.getByTestId('workspace-tool-env').click();
    await page.getByTestId('env-profile-list').waitFor();
  }

  test('the root leads with the current Session, then the profile list', async ({ page }) => {
    await gotoEnvCapability(page);

    // Root: the Session summary and the navigator, under the shell's own bar.
    await expect(page.getByTestId('app-page-header')).toContainText('Environment');
    await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
    const summary = page.getByTestId('env-session-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('fix-terminal-reconnect');
    await expect(summary).toContainText('1 profile · In sync');
    await expect(page.getByTestId('env-profile-list')).toBeVisible();

    // Tapping the summary pushes the Session Environment through the one Back.
    await summary.click();
    await expect(page.getByTestId('env-session-environment')).toBeVisible();
    await expect(page.getByTestId('env-session-status-title')).toHaveText('In sync');
    await expect(page.getByTestId('app-page-header')).toContainText('Session environment');
    await expect(page.getByTestId('env-navigator')).toHaveCount(0);

    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('env-profile-list')).toBeVisible();
    await expect(page.getByTestId('env-session-summary')).toBeVisible();
  });

  test('a tap pushes the detail over the navigator through the shell’s one Back', async ({
    page,
  }) => {
    await gotoEnvCapability(page);
    await page.getByTestId(STAGING_ROW).click();

    await expect(page.getByTestId('env-profile-detail')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('staging.env');
    await expect(page.getByTestId('workspace-tool-bar')).toHaveCount(1);
    await expect(page.getByTestId('env-navigator')).toHaveCount(0);

    // The profile's session link pushes the Session depth instead of stacking.
    await page.getByTestId('env-profile-session-link').click();
    await expect(page.getByTestId('env-session-environment')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('Session environment');

    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('env-profile-list')).toBeVisible();
    await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
  });

  test('Back from a dirty edit confirms through the capability guard, not the shell', async ({
    page,
  }) => {
    await gotoEnvCapability(page);
    await page.getByTestId(STAGING_ROW).click();
    await page.getByTestId('env-edit').click();
    await dirtyTheEditor(page);

    await page.getByTestId('app-page-back').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Discard unsaved changes?');

    // Discard: the shell pops the depth it was asked to leave.
    await page.getByTestId('env-guard-confirm').click();
    await expect(page.getByTestId('env-profile-detail')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('staging.env');
  });

  test('Back from a dirty binding draft confirms, and Keep editing keeps the draft', async ({
    page,
  }) => {
    await gotoEnvCapability(page);
    await page.getByTestId('env-session-summary').click();
    await page.getByTestId('env-manage-binding').click();
    await page.getByTestId(`env-draft-remove-${STAGING_KEY}`).click();
    await expect(page.getByTestId('env-draft-empty')).toBeVisible();

    await page.getByTestId('app-page-back').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Discard unsaved changes?');

    await page.getByTestId('env-guard-cancel').click();
    await expect(page.getByTestId('env-binding-draft')).toBeVisible();
    await expect(page.getByTestId('env-draft-empty')).toBeVisible();
  });
});
