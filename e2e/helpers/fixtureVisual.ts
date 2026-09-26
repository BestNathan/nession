import { expect, type Page } from '@playwright/test';

/**
 * Frozen wall clock for canonical fixture routes. Must stay after fixture
 * session `last_activity` timestamps in fixtureData.ts so relative labels
 * are deterministic (Phase 7 #561).
 */
export const FIXTURE_FROZEN_TIME = new Date('2026-09-01T12:00:00.000Z');

/** Shared screenshot options for canonical visual regression (#548 / #561 Phase 8). */
export const FIXTURE_SCREENSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixelRatio: 0.02,
};

/** Install a fixed clock before navigation so formatRelativeTime is stable. */
export async function freezeFixtureClock(page: Page): Promise<void> {
  await page.clock.install({ time: FIXTURE_FROZEN_TIME });
}

/**
 * Open a file in the fixture's Files view, by driving the tree.
 *
 * The canonical Workspace screens used to be captured with nothing selected, so
 * the viewer never appeared in a baseline — and after the editor convergence it
 * meant the theme and metrics of the code surface were in no golden image at
 * all. The visual gate had nothing to fail on for changes to them, which is how
 * a clock-driven dark theme survived in a light-only product.
 *
 * Driving the tree is how a user opens a file, and the fixture needs no other
 * route: giving it one would put a test concern into the product's
 * `WorkspaceContext`, and `fixtureCapabilityFacts` is explicit that fixture
 * route parameters express capability *resolution inputs*, never resolved
 * state.
 *
 * `web/src/App.tsx` is the target because it is not markdown — a `.md` opens in
 * the preview, and the code surface is what this is here to cover.
 *
 * Each level is awaited before the next click: the tree fills from the
 * fixture's async `listDir`, so clicking a child before its parent has rendered
 * finds nothing.
 */
export async function openFixtureFile(page: Page): Promise<void> {
  // Two shapes, one destination. Web renders a tree of `treeitem`s; App renders
  // a sectioned list whose rows are `file-row-*`, per `app.md`'s
  // capability-internal flows. Which one is present is what tells them apart.
  const first = page.getByTestId('file-row-web');
  const isAppList = (await first.count()) > 0;

  let opened = '';
  for (const name of ['web', 'src', 'App.tsx']) {
    opened = opened === '' ? name : `${opened}/${name}`;
    // App keys rows by the entry's full path (`file-row-web/src`), the tree by
    // the bare name — so accumulating the path is what makes one loop serve
    // both rather than two hand-written sequences.
    const row = isAppList
      ? page.getByTestId(`file-row-${opened}`)
      : page.getByRole('treeitem', { name });
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
  }
  await expect(page.getByTestId('codemirror-editor')).toBeVisible({ timeout: 10_000 });
}

export async function gotoFixtureShell(page: Page): Promise<void> {
  await page.goto('/#/fixture');
  await page.getByTestId('shell').waitFor();
}

export async function gotoFixtureWorkspace(page: Page): Promise<void> {
  await page.goto('/#/fixture/workspace');
  await page.getByTestId('workspace-shell').waitFor();
}

/**
 * Open the App route, optionally with a route parameter.
 *
 * `search` is the query string verbatim (leading `?` included) and is how a
 * case names an *input* the fixture cannot otherwise be given — `?stale=…` for
 * an Agent the last refresh got no answer from. Omitted, the route is the
 * canonical screen the golden baselines capture, which is why the parameter is
 * optional rather than a second helper.
 */
export async function gotoFixtureApp(page: Page, search = ''): Promise<void> {
  await page.goto(`/#/fixture/app${search}`);
  await page.getByTestId('app-layer-root').waitFor();
}

/** Wait for xterm to paint fixture buffer (renderer-agnostic). */
export async function waitForFixtureTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="fixture-terminal"] .xterm-screen').waitFor();
}
