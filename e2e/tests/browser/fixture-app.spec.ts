// e2e/tests/browser/fixture-app.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { openCapsuleCapability } from '../../helpers/capsule';
import { openFixtureFile } from '../../helpers/fixtureVisual';
import {
  shellAnchor,
  swipe,
  startTouch,
  moveTouch,
  endTouch,
  cancelTouch,
} from '../../../e2e/acceptance/shared/swipe-2724-cases.cjs';
import {
  avoidanceState,
  blurActive,
  focusCapsuleComposer,
  installVisualViewportFixture,
  markTerminal,
  resetVisualViewport,
  setKeyboardInset,
  terminalFacts,
  viewportEnvironment,
} from '../../../e2e/acceptance/shared/keyboard-avoidance-browser.cjs';

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
  // …and the Web's circular destination actions (#1204) are just as absent:
  // the App leaves a layer through its own spatial affordances.
  await expect(page.getByTestId('surface-action-open-workspace')).toHaveCount(0);
  await expect(page.getByTestId('surface-action-open-terminal')).toHaveCount(0);
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

  // #1290 removed the Terminal Git Peek; Git is now a Workspace capability.
  // #826's no-reflow proof must open an actual Terminal projection instead.
  await openCapsuleCapability(page, 'terminal-keys');
  await expect(page.getByTestId('terminal-keys-body')).toBeVisible();
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
  //
  // Once, not twice: dismissal steps back one level, and there is one level
  // now. Picking a capability opens its detail, and closing that returns to
  // dormant — the walk this used to make (Peek -> Signal -> dormant, reading
  // `data-depth` between the two clicks) described the two-depth model that no
  // longer exists, and with one depth the second click had nothing left to
  // close. The geometry is asserted at the end because that is the claim — the
  // terminal is where it was once nothing is floating over it.
  await page.getByTestId('capsule-capability-dismiss').click();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  expect(await geometry()).toEqual(dormant);
});

/**
 * #2658: the Terminal carries no automatic status chrome. This supersedes
 * #2621's absolute overlay: the zero-row-height objective remains, but the
 * notice now exists only inside the Capsule's explicit disclosure, after a
 * user gesture.
 *
 * Use the actual 390×844 App fixture and measured boxes, because jsdom has
 * neither geometry nor elementFromPoint hit testing. The baseline, notice and
 * disclosure views must allocate identical terminal dimensions and xterm DOM
 * rows.
 */
test('no automatic notice covers the Terminal; its disclosure is opt-in (#2658)', async ({ page }) => {
  const readGeometry = async () => {
    await expect(page.getByTestId('fixture-terminal').locator('.xterm')).toBeVisible();
    await expect.poll(() => page.locator('.xterm-rows > div').count()).toBeGreaterThan(0);
    return page.evaluate(() => {
      const surface = document.querySelector('[data-testid="terminal-surface"]');
      const host = document.querySelector('[data-terminal-capsule-host]');
      const viewport = document.querySelector('[data-testid="fixture-terminal"]');
      const rect = (el: Element | null) => {
        const b = el?.getBoundingClientRect();
        return b ? { top: Math.round(b.top), height: Math.round(b.height) } : null;
      };
      return {
        surface: rect(surface),
        host: rect(host),
        viewport: rect(viewport),
        rows: document.querySelector('.xterm-rows')?.children.length ?? 0,
      };
    });
  };

  await page.goto('/#/fixture/app');
  const baseline = await readGeometry();
  expect(baseline.rows).toBeGreaterThan(0);
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0);
  await expect(page.getByTestId('terminal-notices-trigger')).toHaveCount(0);

  await page.goto('/#/fixture/app?drop=epoch');
  const withNotice = await readGeometry();
  // Nothing is painted over the grid: the notice content is not even mounted.
  await expect(page.getByTestId('terminal-input-drop')).toHaveCount(0);
  await expect(page.getByTestId('terminal-status-overlay')).toHaveCount(0);
  // Only the Capsule gains a contextual action, and it is painted.
  await expect(page.getByTestId('terminal-notices-trigger')).toBeVisible();
  expect(await paintedCount(page, '[data-testid="terminal-notices-trigger"]')).toBe(1);
  expect(withNotice).toEqual(baseline);

  // The disclosure is the one place the sentence appears, and opening it does
  // not move the grid (it portals outside the Terminal layout).
  await page.getByTestId('terminal-notices-trigger').click();
  const details = page.getByTestId('terminal-notice-details');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('terminal-input-drop'))
    .toContainText('Some input may not have reached the session');
  expect(await readGeometry()).toEqual(baseline);

  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);
  await expect(page.getByTestId('terminal-input-drop')).toHaveCount(0);
  expect(await readGeometry()).toEqual(baseline);

  await page.goto('/#/fixture/app');
  expect(await readGeometry()).toEqual(baseline);
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
  // than to the Terminal. The dock *stays*: the owner's 2026-10-03 decision
  // (#1347) keeps the capsule at every Workspace depth, because losing the
  // capability context the moment a file opens measured worse than a switcher
  // over a pushed page. What #1051 was protecting survives where it still means
  // leaving — the one Back above, named for the parent, and the shell's swipe
  // standing down for it.
  await openFixtureFile(page);
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');

  await expect.poll(() => paintedCount(page, WORKSPACE_HEADERS)).toBe(1);
  await expect.poll(() => paintedCount(page, WORKSPACE_LEAVES)).toBe(1);
  await expect.poll(() => paintedCount(page, WORKSPACE_DOCK)).toBe(1);
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to src');

  await page.screenshot({ path: 'test-results/canonical-app-workspace-pushed.png', fullPage: true });

  // …and the one leave from the viewer returns to the directory that held the
  // file, not straight to the capability root (#1140). Still a pushed depth, so
  // the dock is still there — depth is what the Back's name reports, not what
  // the dock keys on.
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('files-app-list')).toBeVisible();
  await expect(page.getByTestId('app-page-header')).toContainText('src');
  await expect.poll(() => paintedCount(page, WORKSPACE_DOCK)).toBe(1);

  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-page-header')).toContainText('web');
  await page.getByTestId('app-page-back').click();
  await expect(page.getByTestId('app-page-header')).toContainText('Files');
  await expect.poll(() => paintedCount(page, WORKSPACE_DOCK)).toBe(1);
});

test('switching from a pushed Files detail to an Agent root restores the shell return swipe (#2780)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await openFixtureFile(page);
  await expect(page.getByTestId('app-page-header')).toContainText('App.tsx');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to src');

  // The Capsule stays available at every depth (#1347). Switching to a root
  // capability must move the shell's pager with it, not leave the Files depth
  // owner fencing the Agent root.
  await page.getByTestId('workspace-tool-agent').click();
  await expect(page.getByTestId('app-page-header')).toContainText('Agent');
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');

  const anchor = await shellAnchor(page);
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.rightX, y: anchor.y },
  });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);
});

test('the shell return swipe still respects a pushed detail and its dirty guard (#2780)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await openFixtureFile(page);

  // A pushed detail is operated by the capability's own inner stack: a right
  // swipe Pops one level (the directory that held the file), and the outer
  // Workspace layer does not slide. Start on the viewer's non-interactive
  // path chrome: the editor's whole surface is contenteditable and therefore
  // keeps a contact by design, and the host header's title block is the Stack
  // Sheet trigger.
  const viewerPath = await page.getByTestId('file-viewer-path').boundingBox();
  if (!viewerPath) {
    throw new Error('the pushed viewer must lay out its path chrome');
  }
  await swipe(page, {
    from: {
      x: Math.round(viewerPath.x + viewerPath.width / 2),
      y: Math.round(viewerPath.y + viewerPath.height / 2),
    },
    to: {
      x: Math.round(viewerPath.x + viewerPath.width / 2 + 160),
      y: Math.round(viewerPath.y + viewerPath.height / 2),
    },
  });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'workspace');
  await expect(page.getByTestId('app-page-header').locator('h1')).toHaveText('src');

  // Re-open the file so a dirty editor can prove the guard on Back.
  await page.getByTestId('file-row-web/src/App.tsx').click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('draft');
  await page.getByTestId('app-page-back').click();
  await expect(page.getByRole('alertdialog')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Switching to a root capability now releases the pager, and the edit is
  // untouched by that switch (no dialog, no discard).
  await page.getByTestId('workspace-tool-agent').click();
  await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
  const anchor = await shellAnchor(page);
  await swipe(page, {
    from: { x: anchor.leftX, y: anchor.y },
    to: { x: anchor.rightX, y: anchor.y },
  });
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
});

/** The live translateX of an element, in CSS pixels. */
async function translateX(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    if (transform === 'none') {
      return 0;
    }
    const values = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
    return values && values.length === 6 ? values[4] ?? Number.NaN : Number.NaN;
  });
}

async function openPushedFileViewer(page: Page): Promise<{ x: number; y: number }> {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await openFixtureFile(page);
  const viewerPath = await page.getByTestId('file-viewer-path').boundingBox();
  if (!viewerPath) {
    throw new Error('the pushed viewer must lay out its path chrome');
  }
  return {
    x: Math.round(viewerPath.x + viewerPath.width / 2),
    y: Math.round(viewerPath.y + viewerPath.height / 2),
  };
}

test('outer swipe resists past the preferred reveal and the next contact is not dropped (#4185)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#/fixture/app');
  const layerRoot = page.getByTestId('app-layer-root');
  await layerRoot.waitFor();
  const anchor = await shellAnchor(page);
  const width = anchor.shell.width;
  const preferred = Math.round(width * 0.8);

  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await moveTouch(page, { x: anchor.leftX + preferred, y: anchor.y });
  // Sessions is parked at -width; its visible reveal is x + width.
  const atPreferred = (await translateX(page, 'app-layer-sessions')) + width;
  expect(Math.abs(atPreferred - preferred)).toBeLessThanOrEqual(2);

  // Past the former 80% cap the preview keeps moving, with less visual travel
  // than the finger supplies, and never becomes the whole shell.
  const extraFinger = Math.round(width * 0.08);
  await moveTouch(page, { x: anchor.leftX + preferred + extraFinger, y: anchor.y });
  const pastPreferred = (await translateX(page, 'app-layer-sessions')) + width;
  const extraVisual = pastPreferred - atPreferred;
  expect(extraVisual).toBeGreaterThan(0);
  expect(extraVisual).toBeLessThan(extraFinger);
  expect(pastPreferred).toBeLessThan(width * 0.92 + 1);
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

  // Release as a snapback, then reverse immediately: the return settle must
  // catch up instead of swallowing the next contact.
  await moveTouch(page, { x: anchor.leftX + 40, y: anchor.y });
  await page.waitForTimeout(250);
  await endTouch(page, { x: anchor.leftX + 40, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'settling');

  await startTouch(page, { x: anchor.rightX, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'candidate');
  await moveTouch(page, { x: anchor.rightX - 120, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
  await expect(layerRoot).toHaveAttribute('data-swipe-destination', '2');

  await page.waitForTimeout(250);
  await cancelTouch(page, { x: anchor.rightX - 120, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'idle');
  await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);
});

test('a caught-up Workspace-to-Terminal commit keeps the new contact alive (#4185)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#/fixture/app');
  const layerRoot = page.getByTestId('app-layer-root');
  await page.getByTestId('app-header-workspace').click();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  const anchor = await shellAnchor(page);
  const title = await page.getByTestId('app-page-header').locator('h1').boundingBox();
  if (!title) {
    throw new Error('the Workspace header must lay out its title');
  }

  // Workspace root -> Terminal is an outer page commit from shell chrome.
  const point = {
    x: Math.round(title.x + title.width / 2),
    y: Math.round(title.y + title.height / 2),
  };
  await startTouch(page, point);
  await moveTouch(page, { x: point.x + 200, y: point.y });
  await page.waitForTimeout(250);
  await endTouch(page, { x: point.x + 200, y: point.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'settling');

  // Catching it up changes the route and removes the Workspace capability
  // stack in the same render; that must not stand the new contact down.
  await startTouch(page, { x: anchor.leftX, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'candidate');
  await moveTouch(page, { x: anchor.leftX + 120, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
  await expect(layerRoot).toHaveAttribute('data-swipe-destination', '0');

  await page.waitForTimeout(250);
  await cancelTouch(page, { x: anchor.leftX + 120, y: anchor.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'idle');
  await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
});

test('a rejected inner Pop returns with animated frames in place (#4185)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const point = await openPushedFileViewer(page);
  const layerRoot = page.getByTestId('app-layer-root');

  await startTouch(page, point);
  await page.waitForTimeout(150);
  await moveTouch(page, { x: point.x + 50, y: point.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-inner', 'pop');
  expect(await translateX(page, 'workspace-tool-content')).toBeGreaterThan(40);
  await page.waitForTimeout(250);

  // Release below the threshold and sample the frame path; the return must be
  // an in-place animation to zero, not an immediate style removal.
  const frames = await page.evaluate(({ x, y }) => new Promise<number[]>((resolve) => {
    const key = '__nessionSwipe2724Touch';
    const stored = (window as unknown as Record<string, { identifier: number; target: EventTarget } | undefined>)[key];
    if (!stored) {
      resolve([]);
      return;
    }
    const target = stored.target as Element;
    const touch = new Touch({ identifier: stored.identifier, target, clientX: x, clientY: y });
    target.dispatchEvent(new TouchEvent('touchend', {
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
    delete (window as unknown as Record<string, unknown>)[key];

    const element = document.querySelector('[data-testid="workspace-tool-content"]');
    const values: number[] = [];
    const deadline = performance.now() + 320;
    const sample = () => {
      const transform = element ? getComputedStyle(element).transform : 'none';
      const parsed = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(',').map(Number);
      values.push(parsed && parsed.length === 6 ? parsed[4] ?? 0 : 0);
      if (performance.now() < deadline) {
        requestAnimationFrame(sample);
      } else {
        resolve(values);
      }
    };
    requestAnimationFrame(sample);
  }), point);

  expect(frames.length).toBeGreaterThan(3);
  expect(frames.some((value) => value > 1 && value < 45)).toBe(true);
  expect(Math.abs(frames[frames.length - 1] ?? Number.NaN)).toBeLessThanOrEqual(1);
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'idle');
  await expect.poll(async () => Math.abs(await translateX(page, 'workspace-tool-content'))).toBeLessThanOrEqual(1);
});

test('a new Workspace contact during the return settle is caught up, not dropped (#4185)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const point = await openPushedFileViewer(page);
  const layerRoot = page.getByTestId('app-layer-root');

  await startTouch(page, point);
  await page.waitForTimeout(150);
  await moveTouch(page, { x: point.x + 50, y: point.y });
  await page.waitForTimeout(250);
  await endTouch(page, { x: point.x + 50, y: point.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'settling');

  // The next contact lands while the return is visibly running.
  await startTouch(page, point);
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'candidate');
  await moveTouch(page, { x: point.x + 30, y: point.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'navigation');
  await expect(layerRoot).toHaveAttribute('data-swipe-inner', 'pop');

  await page.waitForTimeout(250);
  await cancelTouch(page, { x: point.x + 30, y: point.y });
  await expect(layerRoot).toHaveAttribute('data-swipe-phase', 'idle');
  await expect.poll(async () => Math.abs(await translateX(page, 'workspace-tool-content'))).toBeLessThanOrEqual(1);
});

/**
 * #2710: the terminal-tools slot is two explicit views behind one `+`.
 *
 * These run against the real fixture DOM, which is what proves the interaction
 * the unit tests cannot: the header switch, the composer staying in place, and
 * the upper-panel clearance the capsule publishes for the terminal runtime.
 * Byte-level chord proof needs a PTY and lives in the acceptance cases.
 */
test('Terminal Keys holds one-shot modifiers instead of a chain (#2710 SC-02/SC-03)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  await openCapsuleCapability(page, 'terminal-keys');
  const keys = page.getByTestId('terminal-keys-body');
  await expect(keys).toBeVisible();

  // First-class chords are one tap; the old chain strip and its Send are gone.
  for (const chord of ['Ctrl+C', 'Ctrl+R', 'Ctrl+L']) {
    await expect(page.getByTestId(`quick-chord-${chord}`)).toBeVisible();
  }
  await expect(page.getByTestId('capsule-chain-bar')).toHaveCount(0);

  // Selecting a modifier sends nothing; it opens the letter selector and marks
  // the control as pressed.
  const ctrl = page.getByTestId('terminal-modifier-ctrl');
  await ctrl.click();
  await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('terminal-chord-letters')).toBeVisible();
  await expect(page.getByTestId('terminal-quick-chords')).toHaveCount(0);

  // A letter completes the one-shot chord and clears the selection.
  await page.getByTestId('chord-letter-X').click();
  await expect(page.getByTestId('terminal-chord-letters')).toHaveCount(0);

  // Cancel is an explicit exit from modifier state.
  await page.getByTestId('terminal-modifier-shift').click();
  await expect(page.getByTestId('terminal-chord-cancel')).toBeVisible();
  await page.getByTestId('terminal-chord-cancel').click();
  await expect(page.getByTestId('terminal-quick-chords')).toBeVisible();

  // Direct keys and arrows remain repeatable taps.
  await page.getByTestId('phys-key-Esc').click();
  await page.getByTestId('phys-key-↑').click();
  await expect(keys).toBeVisible();
});

test('Quick Commands separates Insert from Run (#2710 SC-05)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  await openCapsuleCapability(page, 'quick-commands');
  await expect(page.getByTestId('quick-commands-list')).toBeVisible();

  // Insert edits the composer and returns to typing; nothing executes.
  await page.getByTestId('quick-command-insert-fixture-git-status').click();
  await expect(page.getByTestId('capsule-ghost-input')).toHaveValue('git status --short');
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);

  // Run is a separate action on the same row: it neither executes by expanding
  // nor edits the composer text Insert left behind.
  await openCapsuleCapability(page, 'quick-commands');
  await page.getByTestId('quick-command-run-fixture-tests').click();
  await expect(page.getByTestId('quick-commands-list')).toBeVisible();
  await expect(page.getByTestId('capsule-ghost-input')).toHaveValue('git status --short');
});

test('Quick Commands states unavailable actions instead of faking success (#2710 SC-05)', async ({ page }) => {
  await page.goto('/#/fixture/app?commands=disconnected');
  await openCapsuleCapability(page, 'quick-commands');

  // Insert is local text and still works; Run cannot reach a terminal.
  await expect(page.getByTestId('quick-command-insert-fixture-git-status')).toBeEnabled();
  await expect(page.getByTestId('quick-command-run-fixture-git-status')).toBeDisabled();
  await expect(page.getByTestId('quick-commands-unavailable')).toContainText('Run is unavailable');

  await page.goto('/#/fixture/app?commands=error');
  await openCapsuleCapability(page, 'quick-commands');
  await expect(page.getByTestId('quick-commands-error')).toBeVisible();
  await expect(page.getByTestId('quick-commands-retry')).toBeVisible();

  await page.goto('/#/fixture/app?commands=none');
  await openCapsuleCapability(page, 'quick-commands');
  await expect(page.getByTestId('quick-commands-empty')).toBeVisible();
  await expect(page.getByTestId('quick-commands-list')).toHaveCount(0);
});

test('Keys and Commands share one stable slot without moving the composer (#2710 SC-01)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await openCapsuleCapability(page, 'terminal-keys');

  const shellBox = async () => {
    const box = await page.getByTestId('capsule-shell').boundingBox();
    if (!box) throw new Error('capsule shell has no box');
    return box;
  };
  const columns = async () => page.getByTestId('capsule-view-switch').getByRole('button').allTextContents();

  const restingShell = await shellBox();
  // Stable order: the selected view does not move under the finger.
  expect(await columns()).toEqual(['Keys', 'Commands']);

  await page.getByTestId('capsule-view-quick-commands').click();
  await expect(page.getByTestId('quick-commands-list')).toBeVisible();
  expect(await columns()).toEqual(['Keys', 'Commands']);
  expect(await shellBox()).toEqual(restingShell);

  await page.getByTestId('capsule-view-terminal-keys').click();
  await expect(page.getByTestId('terminal-keys-body')).toBeVisible();
  expect(await columns()).toEqual(['Keys', 'Commands']);
  expect(await shellBox()).toEqual(restingShell);

  // The composer is still the same surface, not a replaced mode.
  await expect(page.getByTestId('capsule-ghost-input')).toBeVisible();
});

test('an expanded upper surface publishes scroll clearance, not fit occlusion (#2710 SC-08)', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  const read = () => page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    if (!(host instanceof HTMLElement)) return null;
    const style = getComputedStyle(host);
    return {
      occlusion: style.getPropertyValue('--nession-local-terminal-capsule-occlusion').trim(),
      panel: style.getPropertyValue('--nession-local-terminal-capsule-panel-clearance').trim(),
    };
  });

  await expect.poll(async () => (await read())?.panel).toBe('0px');
  const dormant = await read();

  await openCapsuleCapability(page, 'terminal-keys');
  await expect.poll(async () => {
    const value = await read();
    return value ? Number.parseFloat(value.panel) : 0;
  }).toBeGreaterThan(0);

  // The composer-only fit value is untouched by the upper panel; that is what
  // keeps xterm rows and the PTY size stable while the screen scrolls.
  const emerged = await read();
  expect(emerged?.occlusion).toBe(dormant?.occlusion);

  await page.getByTestId('capsule-capability-dismiss').click();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  await expect.poll(async () => (await read())?.panel).toBe('0px');
});

/**
 * The visible bottom in page coordinates, from the App Environment's own
 * snapshot. Used to assert a focused control really landed above the simulated
 * keyboard instead of trusting the scrollport's arithmetic.
 */
async function visibleBottomInPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const element = document.querySelector('[data-app-viewport-environment]');
    if (!(element instanceof HTMLElement)) return 0;
    const top = Number(element.dataset.appVisibleTop ?? 0);
    const height = Number(element.dataset.appVisibleHeight ?? 0);
    return element.getBoundingClientRect().top + top + height;
  });
}

test.describe('App keyboard avoidance (#3523)', () => {
  test('focus reveals the Capsule with real outer scrolling and unchanged terminal geometry', async ({ page }) => {
    await installVisualViewportFixture(page);
    await page.goto('/#/fixture/app');
    await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
    await page.locator('.xterm').waitFor();
    await expect.poll(async () => (await terminalFacts(page))?.rows ?? 0).toBeGreaterThan(0);
    await markTerminal(page);

    const before = await terminalFacts(page);
    const headerBefore = await page.getByTestId('session-header-line').boundingBox();
    expect((await viewportEnvironment(page))?.layoutHeight).toBe(844);
    expect((await viewportEnvironment(page))?.keyboard).toBe('closed');

    // A visual-viewport shrink with nothing editable focused is a toolbar-like
    // change: visible geometry moves, but no avoidance range and no re-fit.
    await setKeyboardInset(page, 300);
    await expect.poll(async () => (await viewportEnvironment(page))?.visibleHeight).toBe(544);
    await expect.poll(async () => (await viewportEnvironment(page))?.keyboard).toBe('closed');
    expect((await avoidanceState(page))?.scrollable).toBe(false);
    expect((await terminalFacts(page))?.rows).toBe(before?.rows);

    await focusCapsuleComposer(page);
    await expect.poll(async () => (await viewportEnvironment(page))?.keyboard).toBe('open');
    await expect.poll(async () => (await avoidanceState(page))?.scrollable).toBe(true);
    await expect.poll(async () => (await avoidanceState(page))?.scrollTop ?? 0).toBeGreaterThan(0);

    const revealed = await avoidanceState(page);
    const visibleBottom = await visibleBottomInPage(page);
    expect(revealed?.activeTestId).toBe('capsule-ghost-input');
    expect(revealed?.targetBottom ?? Infinity).toBeLessThanOrEqual(visibleBottom - 8);
    expect(revealed?.targetTop ?? 0).toBeGreaterThanOrEqual(0);
    expect((revealed?.extent ?? 0)).toBeGreaterThan(0);
    expect(revealed?.overflowY).toBe('auto');

    // The work surface is not resized: same well/host box, same xterm
    // instance, same rows and the same number of real xterm resizes.
    const after = await terminalFacts(page);
    expect(after?.rows).toBe(before?.rows);
    expect(after?.resizes).toBe(before?.resizes);
    expect(after?.hostHeight).toBe(before?.hostHeight);
    expect(after?.hostWidth).toBe(before?.hostWidth);
    expect(after?.wellHeight).toBe(before?.wellHeight);
    expect(after?.xtermCount).toBe(1);
    expect(after?.xtermIdentity).toBe('original');

    // The one App header stays visible and does not move with the work surface.
    expect(await page.getByTestId('session-header-line').isVisible()).toBe(true);
    expect(await page.getByTestId('session-header-line').boundingBox()).toEqual(headerBefore);

    await blurActive(page);
    await expect.poll(async () => (await avoidanceState(page))?.scrollable).toBe(false);
    await expect.poll(async () => (await avoidanceState(page))?.scrollTop).toBe(0);
    await expect.poll(async () => (await viewportEnvironment(page))?.keyboard).toBe('closed');
    const closed = await terminalFacts(page);
    expect(closed?.rows).toBe(before?.rows);
    expect(closed?.resizes).toBe(before?.resizes);
    await resetVisualViewport(page);
  });

  test('a keyboard-occluded vertical drag moves the outer page, not xterm history', async ({ page }) => {
    await installVisualViewportFixture(page);
    await page.goto('/#/fixture/app');
    await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
    await page.locator('.xterm').waitFor();
    await expect.poll(async () => (await terminalFacts(page))?.rows ?? 0).toBeGreaterThan(0);

    await setKeyboardInset(page, 300);
    await focusCapsuleComposer(page);
    await expect.poll(async () => (await avoidanceState(page))?.scrollable).toBe(true);
    const scrollTopBefore = (await avoidanceState(page))?.scrollTop ?? 0;
    const xtermBefore = (await terminalFacts(page))?.xtermScrollTop;

    const box = await page.getByTestId('fixture-terminal').boundingBox();
    if (!box) throw new Error('the terminal viewport must be laid out');
    // After the reveal the well has been scrolled up, so its own box can start
    // above the visible region. Aim at a point that is actually on screen and
    // inside the Terminal viewport, not at the capsule or the header.
    const visibleBottom = await visibleBottomInPage(page);
    const point = {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(Math.max(80, Math.min(box.y + box.height / 2, visibleBottom - 48))),
    };

    // Finger down: the visible page range is spent by the outer owner.
    await startTouch(page, point);
    await moveTouch(page, { x: point.x, y: point.y + 60 });
    await moveTouch(page, { x: point.x, y: point.y + 120 });
    await endTouch(page, { x: point.x, y: point.y + 120 });
    await expect.poll(async () => (await avoidanceState(page))?.scrollTop ?? -1)
      .toBeLessThan(scrollTopBefore);
    expect((await terminalFacts(page))?.xtermScrollTop, 'xterm history did not also move')
      .toBe(xtermBefore);
    expect((await page.getByTestId('app-layer-root').getAttribute('data-layer'))).toBe('terminal');

    // Finger up at the outer range's end: no outer range exists, so the next
    // contact belongs to the Terminal for its whole duration.
    await page.evaluate(() => {
      const scrollport = document.querySelector('[data-keyboard-avoidance-scrollport]');
      if (scrollport instanceof HTMLElement) {
        scrollport.scrollTop = scrollport.scrollHeight - scrollport.clientHeight;
      }
    });
    const atEnd = (await avoidanceState(page))?.scrollTop ?? 0;
    const xtermAtEnd = (await terminalFacts(page))?.xtermScrollTop;
    const start = { x: point.x, y: Math.round(Math.max(80, visibleBottom - 160)) };
    await startTouch(page, start);
    await moveTouch(page, { x: start.x, y: start.y - 60 });
    await moveTouch(page, { x: start.x, y: start.y - 120 });
    await endTouch(page, { x: start.x, y: start.y - 120 });
    expect((await avoidanceState(page))?.scrollTop, 'exhausted outer range is not claimed')
      .toBe(atEnd);
    expect((await terminalFacts(page))?.xtermScrollTop, 'the terminal keeps that gesture')
      .toBe(xtermAtEnd);
    await resetVisualViewport(page);
  });

  test('the environment maps landscape + safe area and keeps the composer reachable', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await installVisualViewportFixture(page);
    await page.goto('/#/fixture/app');
    await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
    await page.locator('.xterm').waitFor();
    await page.evaluate(() => {
      const element = document.querySelector('[data-app-viewport-environment]');
      if (!(element instanceof HTMLElement)) return;
      element.style.setProperty('--nession-test-safe-area-left', '44px');
      element.style.setProperty('--nession-test-safe-area-bottom', '21px');
    });
    await resetVisualViewport(page);

    await expect.poll(async () => (await viewportEnvironment(page))?.safeAreaLeft).toBe(44);
    await expect.poll(async () => (await viewportEnvironment(page))?.safeAreaBottom).toBe(21);
    expect((await viewportEnvironment(page))?.layoutWidth).toBe(844);

    await setKeyboardInset(page, 210);
    await focusCapsuleComposer(page);
    await expect.poll(async () => (await avoidanceState(page))?.scrollable).toBe(true);
    const revealed = await avoidanceState(page);
    const visibleBottom = await visibleBottomInPage(page);
    expect(revealed?.targetBottom ?? Infinity).toBeLessThanOrEqual(visibleBottom - 8);
    expect(revealed?.scrollTop ?? 0).toBeGreaterThan(0);
    expect((await viewportEnvironment(page))?.visibleHeight).toBe(180);
    await resetVisualViewport(page);
  });
});

// #4602 SC-05: the manual refresh action is the contract in every state, and the
// host pull is only an accelerator over the same current-scope read.
test.describe('App manual refresh and host pull (#4602)', () => {
  async function openSessions(page: Page, query = '') {
    await page.goto(`/#/fixture/app${query}`);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
  }

  async function dragPull(page: Page, dx: number, dy: number) {
    await page.evaluate(([dx, dy]) => {
      const host = document.querySelector('[data-testid="app-sessions-pull-host"]');
      if (!host) { throw new Error('pull host missing'); }
      const rect = host.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + 30;
      host.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
      for (let i = 1; i <= 6; i += 1) {
        host.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 1, clientX: x + (dx * i) / 6, clientY: y + (dy * i) / 6, bubbles: true, cancelable: true,
        }));
      }
      host.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x + dx, clientY: y + dy, bubbles: true }));
    }, [dx, dy]);
  }

  test('the header Refresh exists while healthy and reports its own busy state', async ({ page }) => {
    await openSessions(page);
    const header = page.getByTestId('app-sessions-header');
    const refresh = header.getByLabel('Refresh sessions');
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect(page.getByTestId('app-pull-indicator')).toHaveAttribute('data-phase', 'busy');
    await expect(page.getByTestId('app-pull-indicator')).toHaveAttribute('data-phase', 'idle', { timeout: 3000 });
  });

  test('the header Refresh exists when the list is empty', async ({ page }) => {
    await openSessions(page, '?sessions=none');
    await expect(page.getByTestId('app-sessions-empty')).toBeVisible();
    await expect(page.getByTestId('app-sessions-header').getByLabel('Refresh sessions')).toBeVisible();
  });

  test('a qualified pull commits one refresh; a short pull commits none', async ({ page }) => {
    await openSessions(page);
    const indicator = page.getByTestId('app-pull-indicator');

    await dragPull(page, 0, 30);
    await expect(indicator).toHaveAttribute('data-phase', 'idle');

    await dragPull(page, 0, 90);
    await expect(indicator).toHaveAttribute('data-phase', 'busy');
    await expect(indicator).toHaveAttribute('data-phase', 'idle', { timeout: 3000 });
  });

  test('a horizontal swipe and a non-top drag never arm the pull', async ({ page }) => {
    await openSessions(page);
    const indicator = page.getByTestId('app-pull-indicator');

    await dragPull(page, 90, 10);
    await expect(indicator).toHaveAttribute('data-phase', 'idle');

    await page.evaluate(() => {
      const viewport = document.querySelector('[data-testid="app-sessions-pull-host"] [data-slot="scroll-area-viewport"]');
      if (viewport) { viewport.scrollTop = 200; }
    });
    await dragPull(page, 0, 90);
    await expect(indicator).toHaveAttribute('data-phase', 'idle');
  });
});
