// e2e/specs/ui-contract-matrix.spec.ts
// #547 — canonical Web/App viewport validation matrix.
//
// The matrix itself (ids, sizes, experience tags) is the SINGLE source in
// design/contracts/viewports.json (#545 resolver embeds it into
// design/generated/contracts.json). Nothing below redefines a dimension.
// Describe names carry "<experience>.<viewport>" so CI reports the failing
// experience + viewport in the test title; assertion failures also include
// the viewport id via the helper's structured violation output.
//
// Density isolation: web rows only run web-block assertions (no touch
// target); app rows enforce the app touch target from the app block.
import { expect, test } from '@playwright/test';
import {
  expectNoUnexpectedOverflow,
  expectMaxWidth,
  expectPaddingX,
  expectRadius,
  expectSingleLine,
  expectTokenHeight,
  expectTouchTarget,
  expectVisibleWithin,
} from '../helpers/ui-assert/assertions';
import { loadContracts, type Experience } from '../helpers/ui-assert/contracts';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const { viewports } = loadContracts();

const PATTERN_SESSION_ITEM = 'pattern.session-item';
const PATTERN_WORKSPACE_NAV = 'pattern.workspace-navigation';
const PATTERN_TERMINAL_CAPSULE = 'pattern.terminal-capsule';

function optsFor(pattern: string, experience: Experience, viewport: string) {
  return { pattern, experience, viewport } as const;
}

async function assertSessionRowsClipped(page: Parameters<typeof test>[0]['page'], experience: Experience, viewportId: string) {
  const rows = page.getByTestId('session-item-row');
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i += 1) {
    await expectNoUnexpectedOverflow(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, experience, viewportId));
  }
}

// ── Web experience ─────────────────────────────────────────────────────────

for (const row of viewports.filter((v) => v.experience === 'web')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('session rows stay clipped; workspace direct chrome stays bounded inside the bar', async ({ page }) => {
      await page.goto('/#/fixture');
      await assertSessionRowsClipped(page, 'web', row.id);

      await page.goto('/#/fixture/workspace');
      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();

      // Contextual direct chrome stays bounded at every viewport instead of
      // rendering one permanent slot per registered capability.
      const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
      const direct = nav.locator('button[data-testid^="workspace-tool-"]');
      expect(await direct.count()).toBeGreaterThan(0);
      expect(await direct.count()).toBeLessThanOrEqual(2);

      for (let i = 0; i < (await direct.count()); i += 1) {
        await expect(direct.nth(i)).toBeVisible();
        await expectSingleLine(direct.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
        await expectVisibleWithin(direct.nth(i), bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      }

      const more = page.getByTestId('workspace-capability-more');
      await expect(more).toBeVisible();
      await expectSingleLine(more, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      await expectVisibleWithin(more, bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
    });

    test('terminal capsule controls hold the control token height', async ({ page }) => {
      await page.goto('/#/fixture');
      await assertCapsuleControls(page, 'web', row.id);
    });

    test('a wrapping/overflow regression at this viewport fails automatically', async ({ page }) => {
      // Synthetic clip violation scoped to this matrix row: a fixed-width
      // element must not overflow the viewport-sized clip container.
      await page.setContent(`
        <div id="clip" style="width: 100%; overflow: hidden; box-sizing: border-box;">
          <span style="display: inline-block; width: 6000px;">regression widow</span>
        </div>`);
      await expect(
        expectNoUnexpectedOverflow(page.locator('#clip'), optsFor(PATTERN_SESSION_ITEM, 'web', row.id)),
      ).rejects.toThrow(/UI_CONTRACT_VIOLATION/);

      await page.setContent(`<div id="clip"><span>fits at ${row.width}px</span></div>`);
      await expectNoUnexpectedOverflow(page.locator('#clip'), optsFor(PATTERN_SESSION_ITEM, 'web', row.id));
    });
  });
}

// ── Terminal capsule — the Session's primary input surface ─────────────────

/**
 * `pattern.terminal-capsule` was the one pattern with no matrix row. It appeared
 * exactly once under `e2e/`, in a self-test of the assertion helper that runs
 * against synthetic DOM, so its contract — including the `overflow` strategy —
 * had never been checked against a real screen. Adding the capsule to the
 * fixture is what made these assertions possible.
 */
async function assertCapsuleControls(
  page: import('@playwright/test').Page,
  experience: Experience,
  viewportId: string,
): Promise<void> {
  await expect(page.getByTestId('terminal-capsule')).toBeVisible();

  // The composer's own row is a control band: one line, at the experience's
  // `control.md`. It is the assertion that makes "one visual row at rest" — the
  // App capsule's whole anatomy — executable rather than prose. It was a
  // two-row field-first stack on App (92px against a 44px band) and nothing
  // said so.
  await expectTokenHeight(page.getByTestId('capsule-input-row'),
    optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));

  const band = page.getByTestId('capsule-input-actions');
  await expect(band).toBeVisible();
  await expectTokenHeight(band, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  await expectSingleLine(band, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  await expectNoUnexpectedOverflow(band, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));

  // §Visual contract, promoted from prose to assertions (#825 Goal 2):
  // "capsule radius from semantic design tokens" and "exact spacing and
  // alignment". Both were unverifiable before — the contract had no field for
  // either, so nothing could fail when they drifted.
  const shell = page.getByTestId('capsule-shell');
  await expect(shell).toBeVisible();
  await expectRadius(shell, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  await expectPaddingX(shell, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  // §Web vs App: "centered with a bounded max width". Asserts the *frame*
  // (which carries the bound), not the inner shell. No-op on App, whose block
  // has no maxWidthToken — the doc bounds the Web placement only.
  await expectMaxWidth(page.getByTestId('terminal-capsule'),
    optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));

  const controls = band.locator('button');
  expect(await controls.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await controls.count()); i += 1) {
    const control = controls.nth(i);
    await expect(control).toBeVisible();
    await expectTokenHeight(control, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  }
}

// ── App experience (Mobile Web proxy, interaction/app.md) ──────────────────

for (const row of viewports.filter((v) => v.experience === 'app')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('workspace direct chrome stays bounded and disclosed inside the App bar', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();

      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();

      const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
      const direct = nav.locator('button[data-testid^="workspace-tool-"]');
      expect(await direct.count()).toBeGreaterThan(0);
      expect(await direct.count()).toBeLessThanOrEqual(2);

      // The pattern declares its own App touch floor (touchTarget.compact, #730):
      // this band floats over the terminal, so it is held to 28px rather than the
      // 44px chrome default — and no lower than that.
      for (let i = 0; i < (await direct.count()); i += 1) {
        await expect(direct.nth(i)).toBeVisible();
        await expectTouchTarget(direct.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
        await expectSingleLine(direct.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
        await expectVisibleWithin(direct.nth(i), bar, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      }

      const more = page.getByTestId('workspace-capability-more');
      await expect(more).toBeVisible();
      await expectTouchTarget(more, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      await expectSingleLine(more, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      await expectVisibleWithin(more, bar, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
    });

    test('session rows meet the App touch target and stay clipped', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-sessions').first().click();
      const rows = page.getByTestId('session-item-row');
      await expect(rows.first()).toBeInViewport();
      for (let i = 0; i < 6; i += 1) {
        await expectTouchTarget(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, 'app', row.id));
        await expectNoUnexpectedOverflow(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, 'app', row.id));
      }
    });

    test('terminal capsule controls meet the App touch target', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await assertCapsuleControls(page, 'app', row.id);

      // The App capsule at rest is one row — `[+] [ intent ] [send]` — and its
      // controls share that band with the field rather than sitting beneath it.
      // So there is no second row to trade against, and the field keeps the
      // width it has by not wrapping an action into it: the anchoring assertion
      // is the row height `assertCapsuleControls` now measures, and this is the
      // anatomy that has to stay true for it to hold.
      const more = page.getByTestId('capsule-capability-more');
      await expect(more).toBeVisible();
      await expectTouchTarget(more, optsFor(PATTERN_TERMINAL_CAPSULE, 'app', row.id));

      // Exactly one action beside the field: the primary send. App carries no
      // permanent history, paste, copy or mode control — the capsule is an
      // intent composer, not a terminal toolbar.
      await expect(page.getByTestId('capsule-input-actions').locator('button')).toHaveCount(1);
      for (const absent of [
        'capsule-history-trigger',
        'capsule-paste',
        'capsule-copy',
        'capsule-mode-toggle',
      ]) {
        await expect(page.getByTestId(absent)).toHaveCount(0);
      }

      // Unlike the workspace bar — which floats over the terminal and settles for
      // touchTarget.compact, 28px (#730) — the capsule is the App's primary input
      // surface and is held to the 44px chrome floor.
      const controls = page.getByTestId('capsule-input-actions').locator('button');
      for (let i = 0; i < (await controls.count()); i += 1) {
        await expectTouchTarget(controls.nth(i), optsFor(PATTERN_TERMINAL_CAPSULE, 'app', row.id));
      }
    });
  });
}
