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
  expectNoUnexpectedOverflow,
  expectScrollable,
  expectSingleLine,
  expectTokenHeight,
  expectTouchTarget,
  expectVisibleWithin,
} from '../helpers/ui-assert/assertions';
import { patternBlock } from '../helpers/ui-assert/contracts';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const WEB = { pattern: 'pattern.workspace-navigation', experience: 'web' as const, viewport: 'web.standard-desktop' };
const ITEM_WEB = { pattern: 'pattern.session-item', experience: 'web' as const, viewport: 'web.standard-desktop' };
const ITEM_APP = { pattern: 'pattern.session-item', experience: 'app' as const, viewport: 'app.standard-phone' };
const HEADER_APP = { pattern: 'pattern.session-header', experience: 'app' as const, viewport: 'app.standard-phone' };

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

  test('height: wrong control height fails, token height passes (terminal-toolbar)', async ({ page }) => {
    const toolbar = { pattern: 'pattern.terminal-toolbar', experience: 'web' as const };
    const expected = patternBlock(toolbar.pattern, 'web').heightTokenPx!;
    await page.setContent(`<div id="root" style="height: ${expected}px; box-sizing: border-box;"></div>`);
    await expectTokenHeight(page.locator('#root'), toolbar); // passes

    await page.setContent(`<div id="root" style="height: ${expected + 12}px; box-sizing: border-box;"></div>`);
    await rejectsWith(expectTokenHeight(page.locator('#root'), toolbar), 'height');
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

  test('web: workspace tool entries are single-line and inside the tool bar', async ({ page }) => {
    await page.goto('/#/fixture/workspace');
    const bar = page.getByTestId('workspace-tool-bar');
    await expect(bar).toBeVisible();
    for (const tool of ['files', 'session', 'agent', 'env', 'claude-code']) {
      const button = page.getByTestId(`workspace-tool-${tool}`);
      await expect(button).toBeVisible();
      await expectSingleLine(button, WEB);
      await expectVisibleWithin(button, bar, WEB);
    }
  });
});

test.describe('app fixtures at 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('sessions page rows and header hold their contracts', async ({ page }) => {
    await page.goto('/#/fixture/app');
    // The spatial app opens on the Terminal page — navigate to Sessions
    // first (same as fixture-matrix.spec.ts).
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-spatial-page-sessions')).toBeInViewport();
    const rows = page.getByTestId('session-item-row');
    await expect(rows.first()).toBeInViewport();
    for (let i = 0; i < 6; i += 1) {
      await expectTouchTarget(rows.nth(i), ITEM_APP);
      await expectNoUnexpectedOverflow(rows.nth(i), ITEM_APP);
    }
    // Every spatial page carries its own session-header-line — scope to the
    // visible Sessions page.
    const header = page.getByTestId('app-spatial-page-sessions').getByTestId('session-header-line');
    await expectSingleLine(header, HEADER_APP);
  });
});
