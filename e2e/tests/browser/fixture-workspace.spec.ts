// e2e/tests/browser/fixture-workspace.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

test('canonical Workspace fixture renders the plugin shell', async ({ page }) => {
  await page.goto('/#/fixture/workspace');

  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  // Contextual chrome: the opened capability is the *selected* entry. Capsule V2
  // keeps a slot for every capability that has a Workspace view — being merely
  // registered no longer decides membership, so selection is what distinguishes
  // the opened one.
  await expect(page.getByTestId('workspace-tool-files')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-files')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('workspace-tool-agent')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-agent')).toHaveAttribute('aria-pressed', 'false');

  // files web layout renders tree ‖ editor
  await expect(page.getByTestId('files-web-layout')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-workspace.png', fullPage: true });

  // The capsule is the whole disclosure now: one bounded, horizontally
  // scrollable row holding every capability that has a Workspace view, with no
  // second-level picker to click through. Every remaining entry is asserted by
  // name — so a capability quietly dropping out of the row fails here instead
  // of passing as a shorter run.
  await expect(page.getByTestId('workspace-capability-scroll')).toBeVisible();
  for (const id of ['session', 'agent', 'env', 'sandbox', 'claude-code', 'git']) {
    await expect(page.getByTestId(`workspace-tool-${id}`)).toBeVisible();
  }
});

test('the Terminal destination action sits left of the capability dock (#1204)', async ({ page }) => {
  await page.goto('/#/fixture/workspace');

  const action = page.getByTestId('surface-action-open-terminal');
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute('aria-label', 'Open Terminal');

  // Two adjacent but separate navigations: the circle lives in surface
  // navigation, not in the capability dock.
  await expect(
    page.getByTestId('workspace-surface-navigation').getByTestId('surface-action-open-terminal'),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace capabilities' })
      .getByTestId('surface-action-open-terminal'),
  ).toHaveCount(0);

  // The retired top-right switcher is gone from this surface too.
  await expect(page.getByTestId('surface-switcher')).toHaveCount(0);

  const actionBox = await action.boundingBox();
  const dockBox = await page
    .getByRole('navigation', { name: 'Workspace capabilities' })
    .boundingBox();
  expect(actionBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  if (!actionBox || !dockBox) {
    return;
  }

  // Immediately left of the dock, vertically centered against it. The pair
  // shares the center line, not a height: the dock's height follows its
  // labeled slots (icon over name, #1347), and the #1204 geometry rules ask
  // this action for adjacency and centering — never for matching the dock's
  // extent. The equality asserted here before the labels belonged to the
  // icon-only dock and would re-pin a shape the design retired.
  const gap = dockBox.x - (actionBox.x + actionBox.width);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThanOrEqual(16);
  const actionCenter = actionBox.y + actionBox.height / 2;
  expect(Math.abs(actionCenter - (dockBox.y + dockBox.height / 2))).toBeLessThanOrEqual(8);
});

test('the sessions sidebar is present in the resting shell', async ({ page }) => {
  await page.goto('/#/fixture');
  // Above `lg` the sidebar is a column, not an overlay drawer (#748): there is
  // nothing to "open", and the drawer state no longer exists at this width.
  await expect(page.getByTestId('sidebar-column')).toBeVisible();
  await expect(page.getByTestId('session-drawer')).toHaveCount(0);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});

/**
 * Claude Code Memory reader (#2742).
 *
 * The fixture answers the same `claude-code.memory` snapshot and bounded read
 * units as the provider, so these cases exercise the production `MemoryView` and
 * the shared Markdown pipeline, not a mock renderer. `?memory=` selects the
 * provider input; the screen is the product's.
 */
test('Memory renders linked Markdown, frontmatter and in-snapshot navigation', async ({ page }) => {
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=ready');
  await page.getByRole('tab', { name: 'Memory' }).click();

  await expect(page.getByTestId('claude-code-memory')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('claude-code-memory-source')).toContainText('/work/nession');
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  // The index is a document: list, links, headings — never a raw <pre>.
  await expect(
    page.getByRole('link', { name: 'Architecture constraints' }),
  ).toBeVisible();
  await expect(page.getByTestId('claude-code-memory-raw')).toHaveCount(0);

  // A relative Markdown link selects the topic, renders YAML frontmatter as
  // metadata, and renders the body (table + code) with the shared pipeline.
  await page.getByRole('link', { name: 'Architecture constraints' }).click();
  await expect(page.getByTestId('claude-code-memory-content')).toContainText(
    'Architecture constraints',
  );
  await expect(page.locator('table.nession-frontmatter')).toContainText('owner');
  await expect(page.locator('table.nession-frontmatter')).toContainText('nession');
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeInViewport();
  await expect(page.getByText('Repository', { exact: true })).toBeVisible();
  await expect(page.getByTestId('claude-code-memory-content')).toContainText('fn main');

  // Back to the index through the existing list entry.
  await page.getByRole('button', { name: 'MEMORY.md' }).click();
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  // TOML frontmatter uses the same metadata treatment.
  await page.getByRole('link', { name: 'Interaction principles' }).click();
  await expect(page.locator('table.nession-frontmatter')).toContainText('status');
  await expect(page.getByRole('heading', { name: 'Interaction principles' })).toBeVisible();

  // Raw/preview is an explicit reading choice, not the default.
  await page.getByTestId('claude-code-memory-mode-raw').click();
  await expect(page.getByTestId('claude-code-memory-raw')).toContainText('+++');
  await page.getByTestId('claude-code-memory-mode-preview').click();
  await expect(page.getByRole('heading', { name: 'Interaction principles' })).toBeVisible();

  // Missing and escaping links stay in the reader with a truthful notice.
  await page.getByRole('button', { name: 'MEMORY.md' }).click();
  await page.getByRole('link', { name: 'Missing topic' }).click();
  await expect(page.getByTestId('claude-code-memory-link-notice')).toContainText(
    'not a Markdown file in this Memory snapshot',
  );
  await expect(page.getByRole('heading', { name: 'Nession project memory' })).toBeVisible();

  await page.getByRole('link', { name: 'Escape attempt' }).click();
  await expect(page.getByTestId('claude-code-memory-link-notice')).toContainText(
    'leave the Memory directory',
  );

  // Safe web links keep the shared external-link policy.
  const docs = page.getByRole('link', { name: 'Claude docs' });
  await expect(docs).toHaveAttribute('href', 'https://code.claude.com/docs/en/memory');
  await expect(docs).toHaveAttribute('target', '_blank');
  await expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
});

test('Memory reports incomplete content and never guesses a fragment heading', async ({ page }) => {
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=partial');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByTestId('claude-code-memory')).toHaveAttribute('data-state', 'ready');

  await page.getByRole('link', { name: 'Recovery record' }).click();
  await expect(page.getByTestId('claude-code-memory-partial')).toContainText(
    'not fully loaded',
  );
  await expect(page.getByTestId('claude-code-memory-link-notice')).toContainText(
    'not in the loaded part',
  );
  await expect(page.getByRole('heading', { name: 'Retry strategy' })).toHaveCount(0);

  // The deferred fragment survives the continuation and scrolls once the
  // heading actually renders — no guess, and no second click.
  await page.getByTestId('claude-code-memory-load-more').click();
  await expect(page.getByTestId('claude-code-memory-partial')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Retry strategy' })).toBeInViewport();
  await expect(page.getByTestId('claude-code-memory-link-notice')).toHaveCount(0);
});

test('Memory keeps readable wrapping and bounded scroll at a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/workspace?capability=claude-code&memory=ready');
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.getByTestId('claude-code-memory')).toHaveAttribute('data-state', 'ready');

  await page.getByRole('link', { name: 'Architecture constraints' }).click();
  await expect(page.getByRole('heading', { name: 'Session boundary' })).toBeVisible();
  const content = page.getByTestId('claude-code-memory-content');
  const overflow = await content.evaluate((element) => getComputedStyle(element).overflowY);
  expect(['auto', 'scroll']).toContain(overflow);

  // Long code and tables scroll inside the document, never the page.
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);
});

/**
 * Shared MCP UI kit (#3772).
 *
 * These cases review the kit inside the real Workspace chrome against the
 * deterministic `mcp-kit` fixture host. The kit is not a product capability:
 * the capability capsule gains no entry, and the only navigation it renders is
 * the capability-local server/tool columns.
 */
test('MCP kit keeps the Session context and never probes on view (#3772)', async ({ page }) => {
  await page.goto('/#/fixture/workspace?capability=mcp-kit&mcp=ready');
  await expect(page.getByTestId('mcp-kit')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'AI · MCP' })).toBeVisible();
  await expect(page.getByTestId('mcp-kit-host')).toContainText('Current Session · devbox-01');

  // The kit adds no capability-dock entry and no second global navigation.
  await expect(
    page.getByRole('navigation', { name: 'Workspace capabilities' }).getByText('MCP'),
  ).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'MCP Servers' })).toHaveCount(1);

  await expect(page.getByTestId('mcp-server-row')).toHaveCount(3);
  await expect(page.getByTestId('mcp-server-row').filter({ hasText: 'read-only' })).toHaveCount(1);
  // A view read is configuration only: no Tools exist before an explicit probe.
  await expect(page.getByTestId('mcp-tool-row')).toHaveCount(0);

  await page.getByTestId('mcp-server-row').filter({ hasText: 'nession' }).click();
  await expect(page.getByTestId('mcp-tools-not-probed')).toContainText('never probes');
  await expect(page.getByTestId('mcp-connection-reachability')).toHaveText('Not probed');
  await expect(page.getByTestId('mcp-connection-loaded')).toHaveText('Unknown');

  await page.getByTestId('mcp-connection-test').click();
  await expect(page.getByTestId('mcp-connection-state')).toHaveText('Reachable');
  await page.getByTestId('mcp-tool-row').filter({ hasText: 'session.list' }).click();

  // The contract is readable and complete: both schemas and their raw JSON.
  await expect(page.getByTestId('mcp-schema-input-fields')).toContainText('scope');
  await expect(page.getByTestId('mcp-schema-input-raw')).toContainText('"required"');
  await expect(page.getByTestId('mcp-schema-output-fields')).toContainText('sessions');

  // Inspecting never invokes; the Run depth requires an explicit action.
  await expect(page.getByTestId('mcp-result-empty')).toContainText('never triggers a call');
  await page.getByTestId('mcp-open-runner').click();
  await expect(page.getByTestId('mcp-result-empty')).toBeVisible();
  await page.getByTestId('mcp-run').click();
  await expect(page.getByTestId('mcp-argument-error')).toContainText('Required: scope');
  await page.locator('[data-argument-name="scope"]').fill('current');
  await page.getByTestId('mcp-run').click();
  await expect(page.getByTestId('mcp-result-structured')).toContainText('fixture-session');
  await expect(page.getByTestId('mcp-call-history-row')).toHaveCount(1);

  // The raw envelope keeps unknown fields and redacts credential values.
  await page.getByTestId('mcp-result-tab-raw').click();
  await expect(page.getByTestId('mcp-result-raw')).toContainText('unknownField');
  await expect(page.getByTestId('mcp-result-raw')).toContainText('[redacted]');
  await expect(page.getByTestId('mcp-result-raw')).not.toContainText('fixture-secret-token');

  await page.setViewportSize({ width: 1024, height: 900 });
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(desktopOverflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(phoneOverflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 375, height: 812 });
  const compactOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(compactOverflow).toBeLessThanOrEqual(1);
});

test('MCP stdio probe needs consent and an external Tool has no output schema (#3772)', async ({
  page,
}) => {
  await page.goto('/#/fixture/workspace?capability=mcp-kit&mcp=ready');
  await expect(page.getByTestId('mcp-kit')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('mcp-server-row').filter({ hasText: 'github' }).click();

  await page.getByTestId('mcp-connection-test').click();
  await expect(page.getByTestId('mcp-connection-consent')).toContainText('launches');
  await expect(page.getByTestId('mcp-tool-row')).toHaveCount(0);
  await page.getByTestId('mcp-connection-consent-confirm').click();
  await page.getByTestId('mcp-tool-row').filter({ hasText: 'search_repositories' }).click();
  await expect(page.getByTestId('mcp-schema-output-missing')).toContainText('not advertised');
  await expect(page.getByTestId('mcp-schema-output-fields')).toHaveCount(0);

  await page.getByTestId('mcp-open-runner').click();
  await page.locator('[data-argument-name="query"]').fill('nession');
  await page.getByTestId('mcp-run').click();
  await expect(page.getByTestId('mcp-result-structured')).toContainText('BestNathan/nession');
});

test('MCP isError is an answer, and offline inventory is unavailable rather than empty (#3772)', async ({
  page,
}) => {
  await page.goto('/#/fixture/workspace?capability=mcp-kit&mcp=error');
  await expect(page.getByTestId('mcp-kit')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('mcp-server-row').filter({ hasText: 'nession' }).click();
  await page.getByTestId('mcp-connection-test').click();
  await page.getByTestId('mcp-tool-row').filter({ hasText: 'session.list' }).click();
  await page.getByTestId('mcp-open-runner').click();
  await page.locator('[data-argument-name="scope"]').fill('current');
  await page.getByTestId('mcp-run').click();
  await expect(page.getByTestId('mcp-result-is-error')).toContainText('isError: true');
  await expect(page.getByTestId('mcp-result-structured')).toContainText('PERMISSION_DENIED');

  await page.goto('/#/fixture/workspace?capability=mcp-kit&mcp=offline');
  await expect(page.getByTestId('mcp-inventory-unavailable')).toContainText(
    'unavailable, not empty',
  );
  await expect(page.getByTestId('mcp-server-empty')).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-row')).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-add')).toBeDisabled();
});

test('MCP configuration is adapter-scoped, honors read-only entries, and confirms removal (#3772)', async ({
  page,
}) => {
  await page.goto('/#/fixture/workspace?capability=mcp-kit&mcp=ready&mcpHost=claude');
  await expect(page.getByTestId('mcp-kit')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Claude Code · MCP' })).toBeVisible();

  await page.getByTestId('mcp-server-row').filter({ hasText: 'managed-catalog' }).click();
  await expect(page.getByTestId('mcp-server-read-only')).toContainText('cannot be edited');
  await expect(page.getByTestId('mcp-server-edit')).toHaveCount(0);
  await expect(page.getByTestId('mcp-server-remove')).toHaveCount(0);

  await page.getByTestId('mcp-server-add').click();
  await expect(page.getByTestId('mcp-server-editor')).toBeVisible();
  await expect(page.getByTestId('mcp-editor-scope')).toContainText('Local');
  await page.getByTestId('mcp-editor-name').fill('docs');
  await page.getByTestId('mcp-editor-endpoint').fill('not-a-url');
  await page.getByTestId('mcp-editor-save').click();
  await expect(page.getByTestId('mcp-server-editor')).toBeVisible();
  await page.getByTestId('mcp-editor-endpoint').fill('https://docs.invalid/mcp');
  await page.getByTestId('mcp-editor-save').click();
  await expect(page.getByTestId('mcp-server-row').filter({ hasText: 'docs' })).toHaveCount(1);

  await page.getByTestId('mcp-server-row').filter({ hasText: 'docs' }).click();
  await page.getByTestId('mcp-server-remove').click();
  await expect(page.getByTestId('mcp-server-remove-confirm')).toContainText('Other scopes');
  await page.getByTestId('mcp-server-remove-confirm-button').click();
  await expect(page.getByTestId('mcp-server-row').filter({ hasText: 'docs' })).toHaveCount(0);
});
