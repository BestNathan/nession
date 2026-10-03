import { expect, type Page } from '@playwright/test';

/**
 * Frozen wall clock for canonical fixture routes. Must stay after fixture
 * session `last_activity` timestamps in fixtureData.ts so relative labels
 * are deterministic (Phase 7 #561).
 */
export const FIXTURE_FROZEN_TIME = new Date('2026-09-01T12:00:00.000Z');

/**
 * Shared screenshot options for canonical visual regression (#548 / #561 Phase 8).
 *
 * **`maxDiffPixelRatio` is derived, not picked** (#1038). It was `0.02` from
 * `e838d9dd` until 2026-09-27 with no recorded reason, and every measurement
 * taken since says the same thing: it was far too wide. Two of them:
 *
 * - a *wholly different page* swapped in for a baseline differed by **2.58%**,
 *   so 0.02 sat just under "this is a different screen" (#1038's probe);
 * - replacing the Workspace tool strip with the contextual bar — a real chrome
 *   change that shipped — was **~0.55%** of a 1440x900 frame, well inside it.
 *   That is how the workspace baseline kept showing chrome the app no longer
 *   had through #708, and it cost a wrong issue closure in #714.
 *
 * `0.002` is 10x tighter than `0.02`, and the sentence that used to follow —
 * that it "sits ~2.7x below the smallest change known to have slipped through"
 * — **was falsified by measurement and is corrected here rather than left
 * standing** (#1332). The smallest known slip is now the Claude Code view strip
 * gaining its third tab: **0.091%** of the frame, i.e. *below* this budget
 * rather than 2.7x above it.
 *
 * That is not a reason to move the number. The budget is a *fraction of the
 * frame*, so a chrome change confined to one strip is small by construction,
 * and no ratio tight enough to catch it would stay above the noise floor of a
 * whole 1440x900 frame. What changes is *where* the strictness is applied:
 * chrome that matters is asserted as its own region, where the same change is a
 * large fraction of the measured area — see `*-claude-code-view-tabs.png`. The
 * whole-frame ratios stay as they are, and a region reuses this same budget
 * rather than inventing a second one.
 *
 * The other half of the derivation holds, and it is what lets a region be
 * strict. It said two independent CI regenerations of the same commit produced
 * **byte-identical** baselines for every shared image — and that is measurably
 * too strong, so it is corrected here too. Two regenerations of the same tree:
 * 35 of 37 are byte-identical, and two are not — `app-sessions-status-filtered`
 * by 6 px, `web-env-edit-dirty` by 15 px. Neither is stale; they disagree with
 * *each other*, so the rendering is genuinely non-deterministic there.
 *
 * The conclusion survives because it now rests on the number that matters
 * instead of on file identity: **none of those pixels is past the comparator's
 * own threshold.** The worst YIQ distance among them is 0.016, against a
 * default `threshold` of 0.2 — so Playwright counts zero differing pixels, and
 * this ratio absorbs nothing. That is exactly the claim the derivation needs:
 * what `0.002` governs is geometry and content, not rendering noise. Measured
 * at file level it would have been wrong; measured at comparator level it is
 * right, which is why the number to quote is the YIQ distance.
 *
 * One knob, not two: the ratio scales per frame, so a companion `maxDiffPixels`
 * cap would add config surface without adding protection.
 *
 * Do not widen this to get green — find the cause, or replace the baseline
 * deliberately (`docs/design/design-system/validation.md`).
 */
export const FIXTURE_SCREENSHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  maxDiffPixelRatio: 0.002,
};

/**
 * Assert one piece of chrome as a **region**, under the same budget (#1332).
 *
 * The whole-frame ratio is blind to a small deliberate chrome change, and it
 * has to be: the budget is a fraction of the frame, so a change confined to one
 * strip can be a large, obvious change to a user and 0.091% of the image. That
 * is exactly how a third tab reached CI green while the committed baseline
 * still showed two (#1332), and how the workspace baseline kept a tool strip
 * the app no longer had (#714).
 *
 * The fix is therefore not a tighter number — no whole-frame ratio could catch
 * this and stay above the noise floor — but a *smaller denominator*. The same
 * change against this element is a large fraction of the measured area, so the
 * same `0.002` sees it. Reusing the budget is deliberate: a second, stricter
 * number for regions would be a second thing to justify, and the derivation
 * above is about the comparator, not the size of the picture.
 *
 * Apply it to chrome whose *content* is the thing under test — a strip whose
 * set of tabs, labels or order is a decision someone made — rather than to
 * everything, which would multiply the baseline surface for no added signal.
 */
export async function expectChromeRegion(
  page: Page,
  testId: string,
  name: string,
): Promise<void> {
  await expect(page.getByTestId(testId)).toHaveScreenshot(name, FIXTURE_SCREENSHOT);
}

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
/**
 * Open a capability from the capsule's `+` in either state (#1347 SC-37/40).
 *
 * The Context Disclosure leads with sensed capabilities and keeps the ordinary
 * list one explicit step down (`All capabilities`); while nothing is sensed —
 * on Web always, since a physical keyboard makes Terminal Keys optional rather
 * than sensed — the list is the first layer itself. The helper takes the step
 * when the surface offers it, so a spec says *what* it wants rather than which
 * layer it happens to be on.
 */
export async function openCapsuleCapability(page: Page, id: string): Promise<void> {
  await page.getByTestId('capsule-capability-more').click();

  // Wait for the list to *be* there before asking which shape it has. `count()`
  // on a surface React has not mounted yet reads 0 — the helper then skips the
  // step it should have taken, and the click below waits out its 30s timeout
  // for a row that is behind that step. Measured on CI: the same three cases
  // pass or time out depending on how fast the popup mounts (#1441).
  const picker = page.getByTestId(`capsule-capability-picker-${id}`);
  const all = page.getByTestId('capsule-context-all');
  await expect(all.or(picker).first()).toBeVisible();

  if (await all.isVisible()) {
    await all.click();
  }
  await picker.click();
}

export async function gotoFixtureApp(page: Page, search = ''): Promise<void> {
  await page.goto(`/#/fixture/app${search}`);
  await page.getByTestId('app-layer-root').waitFor();
}

/**
 * Wait for xterm to paint the fixture buffer.
 *
 * Waiting for `.xterm-screen` is not enough, and the difference matters to
 * anything that measures or photographs the terminal: xterm creates that
 * element on `open()`, when the grid is still its 80x24 default — 600px of
 * terminal inside a 362px well, which reads as the *opposite* of what the
 * fixture draws a frame later. The buffer is the signal, because the fixture
 * writes it only once it has sized the grid (#1092) — the two are one step.
 *
 * This used to be described as renderer-agnostic, which it no longer is:
 * `.xterm-rows` is the DOM renderer's. The fixture constructs a bare `Terminal`
 * with no renderer addon, so the DOM renderer is what draws it — the honest
 * note is that the wait now depends on that, rather than on a property nobody
 * checks.
 */
export async function waitForFixtureTerminal(page: Page): Promise<void> {
  await page.locator('[data-testid="fixture-terminal"] .xterm-screen').waitFor();
  await expect
    .poll(async () => (await page.locator('.xterm-rows > div').allTextContents()).join('\n'), {
      timeout: 10_000,
    })
    .toContain('$ git status --short');
}
