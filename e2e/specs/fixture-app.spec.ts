// e2e/specs/fixture-app.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { openFixtureFile } from '../helpers/fixtureVisual';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 390, height: 844 } });

test('canonical App fixture renders the Terminal root', async ({ page }) => {
  await page.goto('/#/fixture/app');

  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('app-layer-root')).toBeVisible();
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
    'data-layer',
    'terminal',
  );

  // single-row header: sessions + workspace affordances, NO switcher, NO
  // duplicated floating buttons. Exactly one header line — the pager mounted
  // every page at once and therefore rendered two permanently (#1049), which
  // is also why a second one reappearing means a layer is mounted that should
  // not be.
  await expect(page.getByTestId('session-header-line')).toHaveCount(1);
  await expect(page.getByTestId('session-header-line').first()).toBeVisible();
  await expect(page.getByTestId('app-header-sessions')).toBeVisible();
  await expect(page.getByTestId('app-header-workspace')).toBeVisible();
  await expect(page.getByTestId('surface-switcher')).toHaveCount(0);
  await expect(page.getByTestId('app-spatial-open-sessions')).toHaveCount(0);

  // the Terminal layer is the root and fills the viewport
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  await page.screenshot({ path: 'test-results/canonical-app-terminal.png', fullPage: true });
});

test('an emerged capability does not reflow the terminal (#826)', async ({ page }) => {
  // Measured in a real browser because jsdom has no layout: the unit test for
  // the clearance hook models the DOM shape, and this is what says the shape
  // matches reality.
  //
  // The occlusion is not advisory — `--terminal-content-bottom-inset` derives
  // from it and `TerminalViewport` spends it as `padding-bottom` inside a
  // `box-border` element xterm is mounted in, so a wrong number is height the
  // terminal loses and re-fits for.
  await page.goto('/#/fixture/app');
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  const read = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-terminal-capsule-host]')!;
      const well = document.querySelector('[data-testid="terminal-well"]')!;
      const xterm = document.querySelector('[data-testid="fixture-terminal"]')!;
      const box = (el: Element) => {
        const b = el.getBoundingClientRect();
        return `${Math.round(b.top)}:${Math.round(b.height)}`;
      };
      return {
        well: box(well),
        xterm: box(xterm),
        occlusion: getComputedStyle(host).getPropertyValue('--terminal-capsule-occlusion').trim(),
      };
    });

  /**
   * Read only once the numbers have stopped moving.
   *
   * The clearance is published by a layout effect and then re-published by a
   * ResizeObserver, and the shell's width measurement settles a frame or two
   * after the route renders. A single read can therefore catch a transient
   * value — which is a fault in this test, not in the product: the claim is
   * about the settled geometry on both sides of the emergence.
   */
  const geometry = async () => {
    let previous = await read();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(50);
      const next = await read();
      if (JSON.stringify(next) === JSON.stringify(previous)) {
        return next;
      }
      previous = next;
    }
    return previous;
  };

  const dormant = await geometry();

  await page.getByTestId('capsule-capability-more').click();
  await page.getByTestId('capsule-capability-picker-git').click();
  await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();

  const emerged = await geometry();

  // The work surface is where it was, to the pixel. Compared with both sides in
  // the message: a bare mismatch here says nothing about which side moved.
  expect({ well: emerged.well, xterm: emerged.xterm }).toEqual({
    well: dormant.well,
    xterm: dormant.xterm,
  });
  // …and so is the height the terminal reserves, because a projection floats
  // over the scrollback rather than being laid out beside it.
  expect({ occlusion: emerged.occlusion }).toEqual({ occlusion: dormant.occlusion });
  expect(emerged.occlusion).not.toBe('0px');

  // Dismissal returns to the same numbers, which is what "continuity" means.
  await page.getByTestId('capsule-capability-dismiss').click();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  expect(await geometry()).toEqual(dormant);
});

/**
 * How many elements matching `selector` a user could actually read right now.
 *
 * Occlusion-aware on purpose. `locator.count()` answers "is it in the DOM", and
 * the defect this measures was exactly a bar that *was* in the DOM and drawn
 * under an opaque layer — the Terminal's session header above the Workspace
 * layer (`#1051`). `elementFromPoint` at each candidate's own centre is what
 * turns "present" into "painted", and it is the same measurement the depth table
 * in the issue was taken with.
 *
 * Painted means: it has a box, its centre is on screen, and the topmost element
 * there is it, an ancestor, or a descendant. An ancestor counts because a
 * wrapper can own the hit area of what it contains.
 */
async function paintedCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const painted = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        return false;
      }
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return false;
      }
      const top = document.elementFromPoint(x, y);
      return top !== null && (el === top || el.contains(top) || top.contains(el));
    };
    return Array.from(document.querySelectorAll(sel)).filter(painted).length;
  }, selector);
}

/**
 * The navigation owners that could be counted at a Workspace depth (`#1051`).
 *
 * A **header** answers "what page am I on?"; a **leave** answers "what does
 * Back mean?". The criterion is one of each at every depth. The dock is counted
 * separately because it is the *root's* capability switcher rather than a bar
 * owning a page — the issue permits it at the root and requires it absent over
 * a pushed detail.
 *
 * The candidates are written out rather than derived from what currently
 * exists, and they include the owners this change *removed* — `app-tool-header`,
 * `files-app-nav`, `files-app-back`, the viewer's `Close file`. A set built from
 * the current tree could not count a reintroduced owner; this one fails on one.
 */
const WORKSPACE_HEADERS =
  '[data-testid="app-page-header"], [data-testid="app-tool-header"], [data-testid="files-app-nav"]';
const WORKSPACE_LEAVES =
  '[data-testid="app-page-back"], [data-testid="app-tool-back"], [data-testid="files-app-back"], button[aria-label="Close file"]';
const WORKSPACE_DOCK = '[data-testid="workspace-tool-bar"]';

/** The App's session bar, whichever layer it was drawn by. */
const SESSION_BAR = '[data-testid="session-header-line"]';

test('App workspace page shows the files plugin app layout', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  await expect(page.getByTestId('app-page-header')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-app-workspace.png', fullPage: true });
});

test('the Workspace layer hides the Terminal it is stacked over (#1051)', async ({ page }) => {
  // The fourth competing owner, measured as a mechanism rather than as a count.
  //
  // The App mounts a `ShellMain` per layer, so the Workspace layer used to draw
  // a second `SessionMainHeader` at the same position as the Terminal layer's —
  // and because its own ground was transparent, the Terminal's bar *and* its
  // scrollback showed through the Workspace's header band. That is the screen
  // the old baseline `app-files-list` captured: two session titles superimposed
  // and `$ git status --short` under the page header.
  //
  // Two assertions, failing for different reasons. The Terminal's bar is still
  // in the DOM — #1049 requires the Terminal never to unmount — so a DOM count
  // proves nothing; what proves the fix is that it is not *painted* while the
  // Workspace is the active layer. And the Terminal's own layer must still be
  // painted when it is the active layer, so "not painted" cannot be satisfied by
  // breaking the Terminal instead.
  await page.goto('/#/fixture/app');
  await expect.poll(() => paintedCount(page, SESSION_BAR)).toBe(1);

  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('app-layer-workspace')).toBeInViewport();
  await expect.poll(() => paintedCount(page, SESSION_BAR)).toBe(0);

  // …and the Terminal's session bar is still there to come back to.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);
  await expect.poll(() => paintedCount(page, SESSION_BAR)).toBe(1);
});

test('the Workspace owns one navigation bar per depth (#1051)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  // Depth 1 — the capability root. One header naming the capability, one leave
  // going to the depth below it, and the dock, which is where peer switching
  // is conceptually valid.
  await expect(page.getByTestId('app-page-header')).toContainText('Files');
  await expect(page.getByTestId('files-app-layout')).toBeVisible();

  await expect.poll(() => paintedCount(page, WORKSPACE_HEADERS)).toBe(1);
  await expect.poll(() => paintedCount(page, WORKSPACE_LEAVES)).toBe(1);
  await expect.poll(() => paintedCount(page, WORKSPACE_DOCK)).toBe(1);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');

  // Depth 2 — the pushed file. Still one header and one leave; the title is now
  // the pushed page's, and the one leave returns to the capability root rather
  // than to the Terminal. The dock is gone: a peer-capability switcher over a
  // pushed page is a second navigation owner, answering to a depth it has no
  // place at.
  await openFixtureFile(page);
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');

  await expect.poll(() => paintedCount(page, WORKSPACE_HEADERS)).toBe(1);
  await expect.poll(() => paintedCount(page, WORKSPACE_LEAVES)).toBe(1);
  await expect.poll(() => paintedCount(page, WORKSPACE_DOCK)).toBe(0);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Files');

  await page.screenshot({ path: 'test-results/canonical-app-workspace-pushed.png', fullPage: true });

  // …and the one leave goes back one depth, not two.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('files-app-list')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Files');
  await expect.poll(() => paintedCount(page, WORKSPACE_DOCK)).toBe(1);
});
