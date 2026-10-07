// e2e/specs/ui-contract-assertions.spec.ts
// #546 — reusable browser UI assertions over design/contracts (#545).
//
// Two halves:
//   1. Broken-fixture proofs — a deliberately violating DOM must make each
//      helper throw UI_CONTRACT_VIOLATION (with a passing sanity case so the
//      helpers are not inverted).
//   2. Real-pattern protection — shipped fixture surfaces (Session rows,
//      Workspace tool strip, App header) measured against their contracts.
//
// Expectations always come from design/generated/contracts.json; the only
// px in this file are intentional violations crafted for the proofs.
import { expect, test, type Page } from '@playwright/test';
import {
  expectAlignedY,
  expectDrawnAffordance,
  expectNoUnexpectedOverflow,
  expectScrollable,
  expectSingleLine,
  expectTokenHeight,
  expectTokenMaxHeight,
  expectTouchTarget,
  expectTouchTargetsWithin,
  expectVisibleWithin,
} from '../helpers/ui-assert/assertions';
import { patternBlock } from '../helpers/ui-assert/contracts';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const WEB = { pattern: 'pattern.workspace-navigation', experience: 'web' as const, viewport: 'web.standard-desktop' };
// The single-line proof needs a pattern that still enforces it. workspace-navigation
// stopped doing so when its entries became labeled slots (`wrap: true`, owner
// follow-up 2026-10-03) — a name may take two lines inside its slot — so the
// proof uses session-header, which inherits the chrome category unchanged.
const HEADER_WEB = { pattern: 'pattern.session-header', experience: 'web' as const, viewport: 'web.standard-desktop' };
const ITEM_WEB = { pattern: 'pattern.session-item', experience: 'web' as const, viewport: 'web.standard-desktop' };
const ITEM_APP = { pattern: 'pattern.session-item', experience: 'app' as const, viewport: 'app.standard-phone' };

async function rejectsWith(assertion: Promise<void>, rule: string): Promise<void> {
  await expect(assertion).rejects.toThrow(/UI_CONTRACT_VIOLATION/);
  await expect(assertion).rejects.toThrow(new RegExp(`rule: ${rule}`));
}

/**
 * How far the work surface is pushed past the viewport, in px.
 *
 * `docs/design/composition.md` — "Extra viewport width belongs to the work
 * surface before it belongs to navigation" — has no contract row, so it is
 * asserted here (#1269). Measured as an *overhang* rather than `scrollWidth`:
 * the shell hides overflow, so `scrollWidth` reports the viewport even while
 * the surface sits 192px beyond it. That is also why this went unnoticed —
 * nothing scrolls, so nothing looks wrong except the terminal's own size.
 */
async function workSurfaceOverhang(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) {
      throw new Error('UI_CONTRACT_VIOLATION — rule: work-surface — the shell has no <main>');
    }
    return Math.round(main.getBoundingClientRect().right - window.innerWidth);
  });
}

// ── 1. Broken-fixture proofs ───────────────────────────────────────────────

test.describe('assertion helpers detect deliberate violations', () => {
  test('single-line: two stacked lines fail, one line passes (web chrome)', async ({ page }) => {
    await page.setContent(`
      <div id="root" style="width: 300px; font-size: 16px; line-height: 20px;">
        <span>one line of text</span>
      </div>`);
    await expectSingleLine(page.locator('#root'), HEADER_WEB); // passes

    await page.setContent(`
      <div id="root" style="width: 300px; font-size: 16px; line-height: 20px;">
        <div>first line</div><div>second line</div>
      </div>`);
    await rejectsWith(expectSingleLine(page.locator('#root'), HEADER_WEB), 'single-line');
  });

  test('single-line is skipped when the contract allows wrap (session-item)', async ({ page }) => {
    await page.setContent(`
      <div id="root" style="width: 300px;"><div>row name</div><div>row metadata line</div></div>`);
    await expectSingleLine(page.locator('#root'), ITEM_WEB); // wrap: true — no violation
  });

  test('height: wrong control height fails, token height passes (terminal-capsule)', async ({ page }) => {
    const capsule = { pattern: 'pattern.terminal-capsule', experience: 'web' as const };
    const expected = patternBlock(capsule.pattern, 'web').heightTokenPx!;
    await page.setContent(`<div id="root" style="height: ${expected}px; box-sizing: border-box;"></div>`);
    await expectTokenHeight(page.locator('#root'), capsule); // passes

    await page.setContent(`<div id="root" style="height: ${expected + 12}px; box-sizing: border-box;"></div>`);
    await rejectsWith(expectTokenHeight(page.locator('#root'), capsule), 'height');
  });

  test('max-height: over the ceiling fails, at or under it passes (context-capsule)', async ({ page }) => {
    const capsule = { pattern: 'pattern.context-capsule', experience: 'app' as const };
    const ceiling = patternBlock(capsule.pattern, 'app').maxHeightTokenPx!;

    await page.setContent(`<div id="root" style="height: ${ceiling - 40}px; box-sizing: border-box;"></div>`);
    await expectTokenMaxHeight(page.locator('#root'), capsule); // under the ceiling — passes

    await page.setContent(`<div id="root" style="height: ${ceiling}px; box-sizing: border-box;"></div>`);
    await expectTokenMaxHeight(page.locator('#root'), capsule); // exactly at it — passes

    await page.setContent(`<div id="root" style="height: ${ceiling + 12}px; box-sizing: border-box;"></div>`);
    await rejectsWith(expectTokenMaxHeight(page.locator('#root'), capsule), 'max-height');
  });

  test('drawn affordance: a smaller circle inside the target passes, a filled one fails (terminal-capsule)', async ({ page }) => {
    // #1034. The App capsule is a 44px touch target holding a smaller painted
    // circle, and both halves are one DOM tree: a control carrying exactly one
    // `capsule-control-visual`. No existing helper can see the inner node —
    // they measure the element they are handed — which is why the pair needs
    // its own assertion rather than a tighter height check.
    //
    // Failing case is the silent revert: an affordance that grew back to the
    // band. Nothing about the control's own box changes when that happens, so
    // `expectTouchTarget` keeps passing and only this helper notices.
    const capsule = { pattern: 'pattern.terminal-capsule', experience: 'app' as const };
    const bandPx = patternBlock(capsule.pattern, 'app').heightTokenPx!;
    const visualPx = patternBlock(capsule.pattern, 'app').visualSizeTokenPx!;

    const control = (inner: number) =>
      `<div id="root" style="width: ${bandPx}px; height: ${bandPx}px;">
         <span data-testid="capsule-control-visual" style="display: block; width: ${inner}px; height: ${inner}px;"></span>
       </div>`;

    await page.setContent(control(visualPx));
    await expectDrawnAffordance(page.locator('#root'), capsule); // passes

    await page.setContent(control(bandPx));
    await rejectsWith(expectDrawnAffordance(page.locator('#root'), capsule), 'drawn-affordance');
  });

  test('overflow: overflowing child fails clip, contained content passes', async ({ page }) => {
    await page.setContent(`
      <div id="root" style="width: 120px; overflow: hidden;">
        <span style="display: inline-block; width: 240px;">wide content</span>
      </div>`);
    await rejectsWith(expectNoUnexpectedOverflow(page.locator('#root'), ITEM_WEB), 'overflow');

    await page.setContent(`<div id="root" style="width: 300px;"><span>fits</span></div>`);
    await expectNoUnexpectedOverflow(page.locator('#root'), ITEM_WEB); // passes
  });

  test('work surface: a floored flex item overhangs, min-w-0 contains it (#1269)', async ({ page }) => {
    // The mechanism #1269 shipped on, in isolation: a flex item with the
    // default `min-width: auto` is floored at its *content*, so a child wider
    // than the space available pushes the row past the viewport instead of
    // being contained. `main` is that item in the shell.
    //
    // `margin: 0` on the body is load-bearing: `setContent` gives it the UA's
    // 8px margin, which shifts the row right and leaves the *contained* case
    // overhanging by 8 — measured, and it fails the assertion below.
    const row = (mainStyle: string) => `
      <body style="margin: 0;">
        <div style="display: flex; width: 100vw;">
          <div style="flex: 0 0 246px;"></div>
          <main style="${mainStyle}"><div style="flex: 0 0 1200px; height: 10px;"></div></main>
        </div>
      </body>`;

    await page.setContent(row('display: flex; flex: 1 1 0%;'));
    expect(await workSurfaceOverhang(page)).toBeGreaterThan(0);

    await page.setContent(row('display: flex; flex: 1 1 0%; min-width: 0;'));
    expect(await workSurfaceOverhang(page)).toBeLessThanOrEqual(0);
  });

  test('touch target: undersized App hit area fails, 44px+ passes (session-item)', async ({ page }) => {
    await page.setContent(`<button id="root" style="width: 24px; height: 24px; padding: 0;"></button>`);
    await rejectsWith(expectTouchTarget(page.locator('#root'), ITEM_APP), 'touch-target');

    await page.setContent(`<button id="root" style="width: 48px; height: 48px; padding: 0;"></button>`);
    await expectTouchTarget(page.locator('#root'), ITEM_APP); // passes
  });

  test('touch target inside: a row that passes while a control in it does not (#1066)', async ({ page }) => {
    // The blind spot itself, reproduced. `expectTouchTarget` measures the box it
    // is handed; a row is 374×60 whether or not a 32px control is sitting in it,
    // so the first line below passes and only the enumeration notices.
    // The first control is a floor-clear one in **both** axes (44×46), so the
    // only thing this fixture can fail on is the control under test. At 40 wide
    // it was itself under the 44px floor and the assertion fired on it instead
    // — the enumeration was right, the fixture was wrong.
    const rowWith = (control: string) => `
      <div id="root" style="width: 374px; height: 60px; display: flex; gap: 8px;">
        <button style="width: 44px; height: 46px; padding: 0;"></button>
        ${control}
      </div>`;

    await page.setContent(rowWith('<button style="width: 32px; height: 32px; padding: 0;"></button>'));
    await expectTouchTarget(page.locator('#root'), ITEM_APP); // passes — the row's own box is fine
    await rejectsWith(expectTouchTargetsWithin(page.locator('#root'), ITEM_APP), 'touch-target-inside');

    await page.setContent(rowWith('<button style="width: 44px; height: 44px; padding: 0;"></button>'));
    await expectTouchTargetsWithin(page.locator('#root'), ITEM_APP); // passes

    // A control that cannot receive the tap is not one: SessionItem keeps both
    // presentations in the DOM and a breakpoint picks one, so counting the
    // `display: none` half would make every row fail in one experience.
    await page.setContent(rowWith('<button style="display: none; width: 32px; height: 32px; padding: 0;"></button>'));
    await expectTouchTargetsWithin(page.locator('#root'), ITEM_APP); // passes
  });

  test('visibility: target sticking out of its container fails', async ({ page }) => {
    await page.setContent(`
      <div id="container" style="position: relative; width: 100px; height: 60px; overflow: hidden;">
        <div id="inside" style="position: absolute; inset: 0 0 0 0;"></div>
      </div>`);
    await expectVisibleWithin(page.locator('#inside'), page.locator('#container'), ITEM_WEB); // passes

    await page.setContent(`
      <div id="container" style="position: relative; width: 100px; height: 60px; overflow: hidden;">
        <div id="outside" style="position: absolute; top: 30px; left: 0; width: 100px; height: 60px;"></div>
      </div>`);
    await rejectsWith(
      expectVisibleWithin(page.locator('#outside'), page.locator('#container'), ITEM_WEB),
      'visibility',
    );
  });

  test('alignment: off-center target fails, centered passes (chrome band)', async ({ page }) => {
    const opts = { pattern: 'pattern.session-header', experience: 'web' as const };
    await page.setContent(`
      <div id="container" style="position: relative; width: 300px; height: 80px;">
        <div class="child" style="position: absolute; top: 30px; width: 100px; height: 20px;"></div>
        <div class="child" style="position: absolute; top: 30px; left: 120px; width: 100px; height: 20px;"></div>
      </div>`);
    const children = page.locator('.child');
    await expectAlignedY([children.nth(0), children.nth(1)], page.locator('#container'), opts); // passes

    await page.setContent(`
      <div id="container" style="position: relative; width: 300px; height: 80px;">
        <div class="child" style="position: absolute; top: 4px; width: 100px; height: 20px;"></div>
        <div class="child" style="position: absolute; top: 56px; left: 120px; width: 100px; height: 20px;"></div>
      </div>`);
    await rejectsWith(
      expectAlignedY([children.nth(0), children.nth(1)], page.locator('#container'), opts),
      'align-y',
    );
  });

  test('scroll owner: overflowing non-scrollable region fails, scrollable passes', async ({ page }) => {
    const list = { pattern: 'pattern.session-list', experience: 'web' as const };
    await page.setContent(`
      <div id="root" style="height: 60px; overflow: hidden;">
        <div style="height: 300px;">tall content</div>
      </div>`);
    await rejectsWith(expectScrollable(page.locator('#root'), list), 'scroll-owner');

    await page.setContent(`
      <div id="root" style="height: 60px; overflow-y: auto;">
        <div style="height: 300px;">tall content</div>
      </div>`);
    await expectScrollable(page.locator('#root'), list); // passes
  });
});

// ── 2. Real-pattern protection ─────────────────────────────────────────────

test.describe('real fixture surfaces satisfy their contracts', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('web: session rows never overflow their own bounds', async ({ page }) => {
    await page.goto('/#/fixture');
    const rows = page.getByTestId('session-item-row');
    await expect(rows).toHaveCount(6);
    for (let i = 0; i < 6; i += 1) {
      await expectNoUnexpectedOverflow(rows.nth(i), ITEM_WEB);
    }
  });

  test('web: a healthy shell keeps infrastructure context quiet', async ({ page }) => {
    await page.goto('/#/fixture');

    // Web has no Session header since #748. The shell is two columns; identity
    // is the selected row, and the only floating control over the work surface
    // is the surface capsule.
    await expect(page.getByTestId('session-header-line')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-column')).toBeVisible();
    await expect(page.getByTestId('sidebar-agents')).toBeVisible();

    // Healthy infrastructure is not permanent chrome — a member that carries
    // nothing actionable must not occupy space.
    await expect(page.getByTestId('agent-context')).toHaveCount(0);
    await expect(page.getByTestId('connection-status')).toHaveCount(0);
    await expect(page.getByTestId('server-connection')).toHaveCount(0);

    // Workspace stays reachable without gestures: the circular destination
    // action beside the capsule is the visible route (#1204), so its presence
    // is what the contract protects.
    await expect(page.getByRole('button', { name: 'Open Workspace' })).toBeVisible();
  });

  test('web: expanding the sidebar gives the work surface its width back (#1269)', async ({ page }) => {
    // #1195 fixed the sidebar column's own width, which is what made
    // *collapsing* hand the space over. Taking it back is the other half, and
    // the half a floor hides: `main` defaults to `min-width: auto`, so once the
    // Terminal had rendered at the collapsed width its grid held the column
    // open and expanding the sidebar left the row 192px past the viewport —
    // with no container resize, so no `terminal.resize` either, and the PTY
    // kept the collapsed cols.
    await page.goto('/#/fixture');
    await expect(page.locator('main')).toHaveCount(1);
    const surface = page.locator('main');
    const width = async () => Math.round(await surface.evaluate((el) => el.getBoundingClientRect().width));

    const expanded = await width();
    expect(await workSurfaceOverhang(page)).toBeLessThanOrEqual(0);

    await page.getByTestId('sidebar-collapse').click();
    await expect.poll(width).toBeGreaterThan(expanded);

    await page.getByTestId('sidebar-rail-expand').click();
    await expect.poll(width).toBe(expanded);
    expect(await workSurfaceOverhang(page)).toBeLessThanOrEqual(0);
  });

  test('web: workspace capsule shows lifecycle-eligible capabilities and hides unavailable ones', async ({ page }) => {
    await page.goto('/#/fixture/workspace');
    const bar = page.getByTestId('workspace-tool-bar');
    await expect(bar).toBeVisible();

    // Capsule V2 (#1347 / #1455): every lifecycle-eligible capability with a
    // Workspace view is directly visible; unavailable/hidden capabilities do
    // not reserve dead navigation chrome.
    const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
    const allCaps = nav.locator('button[data-testid^="workspace-tool-"]');
    expect(await allCaps.count()).toBeGreaterThan(0);

    for (let i = 0; i < (await allCaps.count()); i += 1) {
      await expect(allCaps.nth(i)).toBeVisible();
      await expectSingleLine(allCaps.nth(i), WEB);
      await expectVisibleWithin(allCaps.nth(i), bar, WEB);
    }

    // Capsule V2: the capsule is the scrollable container, not a disclosure trigger.
    const capsule = page.getByTestId('workspace-capability-capsule');
    await expect(capsule).toBeVisible();
    await expectSingleLine(capsule, WEB);
    await expectVisibleWithin(capsule, bar, WEB);

    await page.goto('/#/fixture/workspace?files=unavailable');
    await expect(page.getByTestId('workspace-capability-unavailable')).toBeVisible();
    await expect(page.getByTestId('workspace-tool-files')).toHaveCount(0);
  });

  test('web: capability presence follows what the session was seen running', async ({ page }) => {
    // The route expresses observations (the pane's command and what it ran
    // before); the resolved state is the capability layer's to decide. Asserting
    // the *state* therefore proves the decision ran, not that a fixture echoed
    // a label back.
    await page.goto('/#/fixture/workspace?pane=claude.exe');
    const bar = page.getByTestId('workspace-tool-bar');
    const running = page.getByTestId('workspace-tool-claude-code');
    await expect(running).toHaveAttribute('data-capability-state', 'active');
    await expectSingleLine(running, WEB);
    await expectVisibleWithin(running, bar, WEB);

    await page.goto('/#/fixture/workspace?pane=zsh&observed=claude.exe');
    const ran = page.getByTestId('workspace-tool-claude-code');
    await expect(ran).toHaveAttribute('data-capability-state', 'relevant');
    await expect(ran).toHaveAttribute('data-capability-presence', 'contextual');
    await expectSingleLine(ran, WEB);
    await expectVisibleWithin(ran, bar, WEB);

    // Capsule V2 (#1347 / #1455): lifecycle-eligible capabilities remain in the
    // scrollable Capsule regardless of whether the session has run them.
    // Unavailable/hidden presence is the separate no-slot case above.
    await page.goto('/#/fixture/workspace');
    await expect(page.getByTestId('workspace-tool-claude-code')).toBeVisible();
  });

  test('web: lifecycle-eligible capabilities stay directly visible in the scrollable capsule', async ({ page }) => {
    await page.goto('/#/fixture/workspace?pane=claude.exe');

    // Capsule V2 (#1347 / #1455): there is no numeric cap on eligible direct
    // chrome; the bounded Capsule handles a larger eligible set by scrolling.
    const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
    const allCaps = nav.locator('button[data-testid^="workspace-tool-"]');
    expect(await allCaps.count()).toBeGreaterThan(0);
    // Eligible capabilities are visible in the Capsule rather than a More menu.
    await expect(page.getByTestId('workspace-capability-capsule')).toBeVisible();
  });
});

test.describe('app fixtures at 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('sessions page rows and header hold their contracts', async ({ page }) => {
    await page.goto('/#/fixture/app');
    // The App opens on the Terminal root — navigate to Sessions
    // first (same as fixture-matrix.spec.ts).
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    const rows = page.getByTestId('session-item-row');
    await expect(rows.first()).toBeInViewport();
    for (let i = 0; i < 6; i += 1) {
      await expectTouchTarget(rows.nth(i), ITEM_APP);
      await expectNoUnexpectedOverflow(rows.nth(i), ITEM_APP);
    }
  });
});
