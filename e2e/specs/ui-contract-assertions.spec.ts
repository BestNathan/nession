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
import { expect, test } from '@playwright/test';
import {
  expectAlignedY,
  expectDrawnAffordance,
  expectNoUnexpectedOverflow,
  expectScrollable,
  expectSingleLine,
  expectTokenHeight,
  expectTouchTarget,
  expectTouchTargetsWithin,
  expectVisibleWithin,
} from '../helpers/ui-assert/assertions';
import { patternBlock } from '../helpers/ui-assert/contracts';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const WEB = { pattern: 'pattern.workspace-navigation', experience: 'web' as const, viewport: 'web.standard-desktop' };
const ITEM_WEB = { pattern: 'pattern.session-item', experience: 'web' as const, viewport: 'web.standard-desktop' };
const ITEM_APP = { pattern: 'pattern.session-item', experience: 'app' as const, viewport: 'app.standard-phone' };

async function rejectsWith(assertion: Promise<void>, rule: string): Promise<void> {
  await expect(assertion).rejects.toThrow(/UI_CONTRACT_VIOLATION/);
  await expect(assertion).rejects.toThrow(new RegExp(`rule: ${rule}`));
}

// ── 1. Broken-fixture proofs ───────────────────────────────────────────────

test.describe('assertion helpers detect deliberate violations', () => {
  test('single-line: two stacked lines fail, one line passes (web chrome)', async ({ page }) => {
    await page.setContent(`
      <div id="root" style="width: 300px; font-size: 16px; line-height: 20px;">
        <span>one line of text</span>
      </div>`);
    await expectSingleLine(page.locator('#root'), WEB); // passes

    await page.setContent(`
      <div id="root" style="width: 300px; font-size: 16px; line-height: 20px;">
        <div>first line</div><div>second line</div>
      </div>`);
    await rejectsWith(expectSingleLine(page.locator('#root'), WEB), 'single-line');
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
    const rowWith = (control: string) => `
      <div id="root" style="width: 374px; height: 60px; display: flex; gap: 8px;">
        <button style="width: 40px; height: 46px; padding: 0;"></button>
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

    // Workspace stays reachable without gestures: the floating capsule is the
    // only visible route now, so its presence is what the contract protects.
    await expect(page.getByRole('tab', { name: 'Workspace' })).toBeVisible();
  });

  test('web: workspace direct chrome is bounded and inside the tool bar', async ({ page }) => {
    await page.goto('/#/fixture/workspace');
    const bar = page.getByTestId('workspace-tool-bar');
    await expect(bar).toBeVisible();

    // Direct chrome is contextual and bounded: the fixture opens on Files, so
    // Files is the only direct entry. Capability registration must not grow
    // direct chrome 1:1 with the registry.
    const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
    const direct = nav.locator('button[data-testid^="workspace-tool-"]');
    expect(await direct.count()).toBeGreaterThan(0);
    expect(await direct.count()).toBeLessThanOrEqual(2);

    for (let i = 0; i < (await direct.count()); i += 1) {
      await expect(direct.nth(i)).toBeVisible();
      await expectSingleLine(direct.nth(i), WEB);
      await expectVisibleWithin(direct.nth(i), bar, WEB);
    }

    // More is the disclosure path and shares the same bar contract.
    const more = page.getByTestId('workspace-capability-more');
    await expect(more).toBeVisible();
    await expectSingleLine(more, WEB);
    await expectVisibleWithin(more, bar, WEB);
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

    // Presence is earned, not granted: a session that never ran it keeps the
    // capability out of direct chrome — and out of the bar entirely.
    await page.goto('/#/fixture/workspace');
    await expect(page.getByTestId('workspace-tool-claude-code')).toHaveCount(0);
  });

  test('web: earning presence does not grow direct chrome past its bound', async ({ page }) => {
    await page.goto('/#/fixture/workspace?pane=claude.exe');

    const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
    const direct = nav.locator('button[data-testid^="workspace-tool-"]');
    expect(await direct.count()).toBeLessThanOrEqual(2);
    // The ones that did not fit are disclosed, not dropped.
    await expect(page.getByTestId('workspace-capability-more')).toBeVisible();
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
