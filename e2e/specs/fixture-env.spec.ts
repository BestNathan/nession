// e2e/specs/fixture-env.spec.ts
//
// #1202 — Environment as a context-first capability, asserted against real DOM
// through the fixture's canned `server.env.*` backend (fixtureEnv.ts). Every
// state here emerges from the files the fixture serves: the masked row exists
// because staging.env holds a sensitive-looking key, the in-use dialog because
// prod.env is used by two sessions, the skipped-line warning because
// staging.env has a line with no '='.
//
// The assertions are shape-based, not copy-based, except where the criterion
// *is* the copy (the Environment-language empty state, the impact dialog that
// must never say "Force").
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtureApp } from '../helpers/fixtureVisual';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const STAGING_ROW = 'env-profile-row-server::staging.env';
const PROD_ROW = 'env-profile-row-agent:devbox-01:prod.env';
const LOCAL_ROW = 'env-profile-row-agent:devbox-01:local.env';

async function gotoEnvWorkspace(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=env');
  // The list is what the list answer produces, so waiting for it is what makes
  // everything below about resolved profiles rather than a pending read.
  await page.getByTestId('env-profile-list').waitFor();
}

/** Type into the CodeMirror editor that is showing, so the draft goes dirty. */
async function dirtyTheEditor(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.type('EXTRA=1');
  await expect(page.getByTestId('env-editor-dirty')).toBeVisible();
}

test.describe('Web 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the navigator is the capability’s own master list, with Session usage quiet', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);

    // Three profiles, each leading with its name and one metadata line —
    // location · var count, never a file size.
    await expect(page.getByTestId(STAGING_ROW)).toContainText('staging.env');
    await expect(page.getByTestId(STAGING_ROW)).toContainText('Server · 6 vars');
    await expect(page.getByTestId(PROD_ROW)).toContainText('devbox-01 · 4 vars');
    await expect(page.getByTestId(LOCAL_ROW)).toBeVisible();

    // The Session's usage is obvious without noise: a summary naming the
    // active profile, and a quiet "Active" on that row only.
    await expect(page.getByTestId('env-session-summary')).toContainText('staging.env');
    await expect(page.getByTestId(STAGING_ROW)).toContainText('Active');
    await expect(page.getByTestId(PROD_ROW)).not.toContainText('Active');

    // Nothing destructive lives on a row — delete is a Profile Detail depth.
    await expect(
      page.getByTestId('env-navigator').locator('[data-testid*="delete"]'),
    ).toHaveCount(0);
  });

  test('selecting a profile reads it first — sensitive masked, empty is not masked', async ({
    page,
  }) => {
    await gotoEnvWorkspace(page);
    await page.getByTestId(STAGING_ROW).click();

    await expect(page.getByTestId('env-profile-detail')).toBeVisible();
    await expect(page.getByTestId('env-profile-active')).toBeVisible();

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
    await expect(dialog).toContainText('Save and update running sessions?');
    await expect(dialog).toContainText('api-tests, deploy');
    await expect(dialog).not.toContainText(/force/i);
  });

  test('the empty inventory speaks Environment, not files', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env&env=empty');
    await expect(page.getByTestId('env-navigator-empty')).toContainText('No environments yet');
  });
});

test.describe('App 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function gotoEnvCapability(page: Page): Promise<void> {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').click();
    // Environment earns no direct dock slot at rest — `available` is
    // discoverable, so the App reaches it through the capability picker, the
    // same walk a user takes.
    await page.getByTestId('workspace-capability-more').click();
    await page.getByTestId('workspace-capability-picker-env').click();
    await page.getByTestId('env-profile-list').waitFor();
  }

  test('a tap pushes the detail over the navigator through the shell’s one Back', async ({
    page,
  }) => {
    await gotoEnvCapability(page);

    // Root: the navigator, the header naming the capability, the dock offering
    // peer switching — valid here and nowhere deeper.
    await expect(page.getByTestId('app-page-header')).toContainText('Environment');
    await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

    await page.getByTestId(STAGING_ROW).click();
    await expect(page.getByTestId('env-profile-detail')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('staging.env');
    // A peer switcher over a pushed page is a second navigation owner.
    await expect(page.getByTestId('workspace-tool-bar')).toHaveCount(0);
    await expect(page.getByTestId('env-navigator')).toHaveCount(0);

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
});
