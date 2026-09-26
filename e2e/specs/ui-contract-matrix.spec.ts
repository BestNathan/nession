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
  expectDrawnAffordance,
  expectNoUnexpectedOverflow,
  expectMaxWidth,
  expectPaddingX,
  expectRadius,
  expectSingleLine,
  expectTokenHeight,
  expectTouchTarget,
  expectTouchTargetsWithin,
  expectVisibleWithin,
  waitForSettledBox,
} from '../helpers/ui-assert/assertions';
import { loadContracts, type Experience } from '../helpers/ui-assert/contracts';
import { swipeHorizontally } from '../helpers/shell';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const { viewports } = loadContracts();

const PATTERN_SESSION_HEADER = 'pattern.session-header';
const PATTERN_SESSION_ITEM = 'pattern.session-item';
const PATTERN_WORKSPACE_NAV = 'pattern.workspace-navigation';
const PATTERN_TERMINAL_CAPSULE = 'pattern.terminal-capsule';
const PATTERN_POPUP_MENU = 'pattern.popup-menu';

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

/**
 * Open the list behind `trigger` and hold it to `pattern.popup-menu` (#1066).
 *
 * The list is the one control surface no other assertion in this file can
 * reach: base-ui mounts it on `<body>`, so it is a sibling of `#root` rather
 * than a descendant of the bar, band or row it was opened from. That is also why
 * it used to render at the wrong density — it inherited from `:root` instead of
 * from the `[data-experience]` scope its trigger sits in — and why the contract
 * is measured on the *items*: `expectTokenHeight` on the menu would only say how
 * tall the box is.
 *
 * Both experiences call this. On Web the touch floor is a no-op by contract
 * (`experience.web` declares no `touchTargetToken`) and the height assertion
 * pins the 28px rows Web already had, so "the App stops inheriting Web's, and
 * Web does not adopt App's" is checked from both sides.
 */
async function assertPopupMenu(
  page: import('@playwright/test').Page,
  experience: Experience,
  viewportId: string,
  trigger: import('@playwright/test').Locator,
): Promise<void> {
  const opts = optsFor(PATTERN_POPUP_MENU, experience, viewportId);

  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // `toBeVisible` resolves on the animation's first frame, where a 44px row
  // measures 43.57px. Measured, not assumed: the floor is pixel-exact, so the
  // read has to come from a settled frame (see `waitForSettledBox`).
  await waitForSettledBox(menu);

  const items = menu.getByRole('menuitem');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    await expectTokenHeight(items.nth(i), opts);
    await expectSingleLine(items.nth(i), opts);
  }
  await expectNoUnexpectedOverflow(menu, opts);

  // The items *are* the controls; the menu is only their box. A height check on
  // the menu passes for a list of 32px rows in a 340px column, which is the
  // shape this pattern exists to forbid.
  await expectTouchTargetsWithin(menu, opts);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

// ── Web experience ─────────────────────────────────────────────────────────

for (const row of viewports.filter((v) => v.experience === 'web')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('session rows stay clipped; workspace chrome and the menu it discloses stay bounded', async ({ page }) => {
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

      await assertPopupMenu(page, 'web', row.id, more);
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
    // Both axes of a control (#1034), measured as the contract splits them: the
    // hit target above, and the affordance painted inside it here. The second
    // call is not a duplicate of the first — on App both tokens are 44px, so the
    // height check alone cannot tell a 44px control holding a 36px circle from
    // one that filled its box, and the matrix is where that would go unnoticed.
    await expectDrawnAffordance(control, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
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
        // The row is not its controls (#1066). The two assertions above measure
        // the row's own box — 374×60, comfortably over the floor — and so kept
        // passing while the App drew 32px Settings/Kill icons inside it. This is
        // the one that enumerates them.
        await expectTouchTargetsWithin(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, 'app', row.id));
      }
    });

    test('a collapsed control opens a menu of App-density rows', async ({ page }) => {
      await page.goto('/#/fixture/app');

      // The capsule's `+` — `CapabilityDisclosureMenu`, the list #1066 found
      // already shipping 28px rows inside a 44px floor.
      await assertPopupMenu(page, 'app', row.id, page.getByTestId('capsule-capability-more'));

      // The session row's `…` — the menu the issue was measured on, and a
      // different trigger path: the capsule is inside the Terminal layer, the
      // row inside the Sessions one, so a container that only worked for one of
      // them would fail here.
      await page.getByTestId('app-header-sessions').first().click();
      const rowLocator = page.getByTestId('session-item-row').first();
      await expect(rowLocator).toBeVisible();
      await assertPopupMenu(
        page,
        'app',
        row.id,
        rowLocator.getByRole('button', { name: /^Session actions for/ }),
      );
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

    test('a pushed Workspace detail keeps its own leave (#1081)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

      await page.getByTestId('app-header-workspace').first().click();
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

      // Push a file detail. Files declares the push, so the shell's page header
      // becomes that depth's bar and Back now names the depth below it.
      await page.getByTestId('file-row-web').click();
      await page.getByTestId('file-row-web/src').click();
      await page.getByTestId('file-row-web/src/App.tsx').click();
      const back = page.getByTestId('app-page-back');
      await expect(back).toHaveAttribute('aria-label', 'Back to Files');

      const shell = await layerRoot.boundingBox();
      const editor = await page.locator('.cm-editor').boundingBox();
      if (!shell || !editor) {
        throw new Error('the pushed detail must lay out a shell and an editor');
      }
      const y = Math.round(editor.y + editor.height / 2);

      // From inside the editor's own left edge — CodeMirror's line-number
      // gutter sits at x = 0, so this is the touch the edge band re-admitted,
      // and before this rule it left the whole depth and discarded whatever
      // `Back to Files` was guarding.
      await swipeHorizontally(page, { y, fromX: shell.x + 10, toX: shell.x + 170 });
      await page.waitForTimeout(300);
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');
      await expect(back).toHaveAttribute('aria-label', 'Back to Files');

      // …and the depth's own leave still works, one level, as its Back says.
      await back.click();
      await expect(page.getByTestId('app-page-back')).toHaveAttribute('aria-label', 'Back to terminal');

      // The pair: at the capability root the shell's gesture is back, because
      // there Back and the shell both mean the Terminal.
      await swipeHorizontally(page, { y, fromX: shell.x + 10, toX: shell.x + 170 });
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
    });

    test('the no-Session root is a home with an action, not a status line (#1082)', async ({ page }) => {
      await page.goto('/#/fixture/app?selection=none');

      await expect(page.getByTestId('app-home')).toBeVisible();
      // The screen it replaced: a status report with nothing to act on, and no
      // route back to the Sessions list once the drawer was dismissed.
      await expect(page.getByTestId('session-empty-state')).toHaveCount(0);

      const create = page.getByTestId('app-home-new-session');
      await expect(create).toBeEnabled();
      await expect(create).toBeVisible();

      // Both ways out are visible controls — a gesture is an accelerator, and
      // on this screen the only layer to reach is Sessions.
      await expect(page.getByTestId('app-home-browse-sessions')).toBeVisible();
      const sessions = page.getByTestId('app-header-sessions');
      await expect(sessions).toBeVisible();
      // Same affordance, same band, same control as on a selected Session, so
      // it is held to the chrome pattern's App touch floor rather than to a
      // number written here.
      await expectTouchTarget(sessions, optsFor(PATTERN_SESSION_HEADER, 'app', row.id));

      // Workspace is the depth *around* work. With none, it is not offered —
      // and the layer it would open does not exist either.
      await expect(page.getByTestId('app-header-workspace')).toHaveCount(0);
      await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);
    });

    test('the no-Session root pages to Sessions and to nothing else (#1082)', async ({ page }) => {
      await page.goto('/#/fixture/app?selection=none');
      await expect(page.getByTestId('app-home')).toBeVisible();

      const shell = await page.getByTestId('app-layer-root').boundingBox();
      if (!shell) {
        throw new Error('the App shell must be laid out');
      }
      const y = shell.y + shell.height / 2;

      // Leftward from the right edge band. There is no third position to page
      // to, so this must be a no-op rather than a slide onto a blank depth.
      await swipeHorizontally(page, {
        y,
        fromX: shell.x + shell.width - 2,
        toX: shell.x + shell.width - 150,
      });
      // A no-op is an absence, so it needs a window in which a wrong commit
      // could land before the positive case below makes the silence evidence.
      await page.waitForTimeout(300);
      await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
      await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

      // Rightward from the left edge band: the one layer that does exist.
      await swipeHorizontally(page, { y, fromX: shell.x + 2, toX: shell.x + 150 });
      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
    });

    test('the top-level swipe reaches the work surface from the shell edge (#1081)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

      const shell = await layerRoot.boundingBox();
      const surface = await page.locator('.xterm').first().boundingBox();
      if (!shell || !surface) {
        throw new Error('the App shell and its terminal surface must both be laid out');
      }
      const y = shell.y + shell.height / 2;

      // The probe is 4px inside the *surface's own* left edge rather than a
      // fixed 4px from the shell: what has to hold is that the band reaches
      // past the terminal's padding gutter and onto the surface, and the
      // gutter is `--terminal-pad-x`. Narrow the band below `surface.x + 4`
      // and this fails — which is right, because the band would then add
      // nothing the gate did not already allow.
      await swipeHorizontally(page, { y, fromX: surface.x + 4, toX: surface.x + 144 });

      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
    });

    test('the work surface keeps a drag that starts inside it (#1081)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

      const shell = await layerRoot.boundingBox();
      const surface = await page.locator('.xterm').first().boundingBox();
      if (!shell || !surface) {
        throw new Error('the App shell and its terminal surface must both be laid out');
      }
      const y = shell.y + shell.height / 2;

      // The middle of the surface is nobody's edge. Nothing may be claimed
      // there — that is the half of #1049 that #1081 did not touch.
      const middle = Math.round(surface.x + surface.width / 2);
      await swipeHorizontally(page, { y, fromX: middle, toX: middle + 140 });

      // Absence, so it needs a window in which a wrong commit could land: the
      // shell's own state updates land a tick late (React commits out of band),
      // and a bare `toHaveCount(0)` would pass before the gesture had been
      // processed at all.
      await page.waitForTimeout(300);
      await expect(page.getByTestId('app-layer-sessions')).toHaveCount(0);

      // …and the same swipe from the shell edge then opens it, which is what
      // makes the silence above evidence rather than timing. Without this, a
      // build where the pager was simply never wired up would pass.
      const shellEdge = Math.round(surface.x + 4);
      await swipeHorizontally(page, { y, fromX: shellEdge, toX: shellEdge + 140 });
      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
    });
  });
}
