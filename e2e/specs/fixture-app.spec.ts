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
 * What is navigating the Workspace screen right now (#1051).
 *
 * "One navigation bar owns the current App page/depth" is only a fact if it is
 * counted, so this is the count. A **header** answers "what page am I on?"; a
 * **leave** answers "what does Back mean?". The criterion is one of each at
 * every depth, and the dock is measured separately because it is the *root's*
 * capability switcher rather than a bar owning a page.
 *
 * Scoped to the Workspace layer: the Terminal layer keeps its own header
 * mounted underneath (#1049 — the Terminal is never unmounted), and the layer
 * is opaque, so what the user reads is what is inside this element.
 *
 * The candidates are written out rather than derived from a class, and they
 * include the owners this change *removed* — `app-tool-header`, `files-app-nav`,
 * `files-app-back`, the viewer's `Close file`. A set built from what currently
 * exists could not count a reintroduced owner; this one fails on one.
 */
function workspaceNavigationOwners(page: Page) {
  const layer = page.getByTestId('app-layer-workspace');
  return {
    headers: layer.locator(
      '[data-testid="app-page-header"], [data-testid="app-tool-header"], [data-testid="files-app-nav"]',
    ),
    leaves: layer.locator(
      '[data-testid="app-page-back"], [data-testid="app-tool-back"], [data-testid="files-app-back"], button[aria-label="Close file"]',
    ),
    dock: layer.getByTestId('workspace-tool-bar'),
  };
}

test('App workspace page shows the files plugin app layout', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  await expect(page.getByTestId('app-page-header')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-app-workspace.png', fullPage: true });
});

test('the Workspace owns one navigation bar per depth (#1051)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  // Depth 1 — the capability root. One header naming the capability, one leave
  // going to the depth below it, and the dock, which is where peer switching
  // is conceptually valid.
  await expect(page.getByTestId('app-page-header')).toContainText('Files');
  await expect(page.getByTestId('files-app-layout')).toBeVisible();

  const root = workspaceNavigationOwners(page);
  await expect(root.headers).toHaveCount(1);
  await expect(root.leaves).toHaveCount(1);
  await expect(root.dock).toHaveCount(1);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');

  // Depth 2 — the pushed file. Still one header and one leave; the title is now
  // the pushed page's, and the one leave returns to the capability root rather
  // than to the Terminal. The dock is gone: a peer-capability switcher over a
  // pushed page is a second navigation owner, answering to a depth it has no
  // place at.
  await openFixtureFile(page);
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');

  const pushed = workspaceNavigationOwners(page);
  await expect(pushed.headers).toHaveCount(1);
  await expect(pushed.leaves).toHaveCount(1);
  await expect(pushed.dock).toHaveCount(0);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Files');

  await page.screenshot({ path: 'test-results/canonical-app-workspace-pushed.png', fullPage: true });

  // …and the one leave goes back one depth, not two.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('files-app-list')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('Files');
  await expect(workspaceNavigationOwners(page).dock).toHaveCount(1);
});
