// e2e/tests/browser/ui-contract-matrix.spec.ts
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
  expectTokenMaxHeight,
  expectTouchTarget,
  expectTouchTargetsWithin,
  expectVisibleWithin,
  waitForSettledBox,
} from '../../helpers/ui-assert/assertions';
import { loadContracts, patternBlock, type Experience } from '../../helpers/ui-assert/contracts';
import { swipeHorizontally } from '../../helpers/shell';
import { waitForFixtureTerminal } from '../../helpers/fixtureVisual';

import {
  viewports,
  PATTERN_SESSION_HEADER,
  PATTERN_SESSION_ITEM,
  PATTERN_WORKSPACE_NAV,
  PATTERN_TERMINAL_CAPSULE,
  PATTERN_POPUP_MENU,
  PATTERN_CONTEXT_CAPSULE,
  optsFor,
  assertSessionRowsClipped,
  assertPopupMenu,
  upperCapsuleVisualSignature,
  assertContextCapsule,
  contextCapsuleBoxInState,
  assertSameHeightAcrossSenseStates,
  assertRowOpensDetail,
  assertWorkspaceEntryStateKeepsVisualGrammar,
  capsuleOuterBox,
  captureProductionWorkspaceCapabilityRow,
  assertProductionCapabilityCountOnlyChangesScrollExtent,
  assertCapabilityRowCssStress,
  assertWebCapsuleOuterGeometry,
  assertDestinationSharesCapsuleMaterial,
  assertWorkRingPerceptible,
  assertCapsuleControls
} from '../../helpers/uiContractMatrix';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

// ── App experience (Mobile Web proxy, interaction/app.md) ──────────────────

for (const row of viewports.filter((v) => v.experience === 'app')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('workspace capsule shows lifecycle-eligible capabilities in the App bar', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();

      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();

      // Capsule V2 (#1347 / #1455): eligible capability slots scroll inside one fixed band.
      const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
      const allCaps = nav.locator('button[data-testid^="workspace-tool-"]');
      expect(await allCaps.count()).toBeGreaterThan(0);

      // The entries carry the standard App control band — the pattern declares
      // no compact override since the 2026-10-03 Capsule-family decision — so
      // the contract's resolved target is the chrome floor (44px). Their
      // visibility is asserted on the *capsule container* below, not per
      // entry: six labeled slots are wider than a phone, and the row scrolling
      // internally instead of cramming is exactly what SC-06 requires, so an
      // entry scrolled out of the capsule's viewport is the design working.
      for (let i = 0; i < (await allCaps.count()); i += 1) {
        await expect(allCaps.nth(i)).toBeAttached();
        await expectTouchTarget(allCaps.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
        await expectSingleLine(allCaps.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      }

      const capsule = page.getByTestId('workspace-capability-capsule');
      await expect(capsule).toBeVisible();
      await expectTouchTarget(capsule, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      await expectSingleLine(capsule, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      await expectVisibleWithin(capsule, bar, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));

      const env = page.getByTestId('workspace-tool-env');
      await expect(page.getByTestId('workspace-tool-env-label')).toHaveText('Env');
      await expect(env).toHaveAttribute('aria-label', 'Environment');
      await expect(env).toHaveAttribute('title', 'Environment');
      await expect(env.locator(':scope > span')).toHaveCount(1);
    });

    test('the two App Capsule states are one family (#1347 SC-30)', async ({ page }) => {
      // SC-30 exists because per-state verification stayed green while the two
      // states drifted apart: 22px semantic radius over a 44/36 control band on
      // the Conversation Form, a 9999px pill over a 28px dock on the Capability
      // Form. This is the relational assertion — both states measured in one
      // scenario and compared to each other, so a change that moves only one of
      // them fails here even though both still "pass" alone.
      //
      // Height IS compared, and that is a correction (owner, 2026-10-03): the
      // first labeled build let the entries carry their own vertical mass, the
      // form grew to 82px over the composer's 56, and it read as a different
      // object in the same slot. The entries now take the canonical
      // `control.md` band directly, so content cannot reinterpret that height
      // as a floor and grow the Capsule.
      // The shape attribute sits on each state's own outer object — the
      // Conversation dock (`terminal-capsule`) and the capability nav.
      //
      // Every axis the criterion names is read here, not just the three it
      // started with: SC-29/30 say surface, elevation, radius, vertical mass,
      // inset and spacing rhythm, and the two states drifting on *shadow* or
      // *padding* while radius and height still matched would have passed the
      // first version of this test.
      const geometryOf = async (testId: string, shapeTestId: string) => {
        const el = page.getByTestId(testId);
        await expect(el).toBeVisible();
        const measured = await el.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            radius: style.borderRadius,
            height: rect.height,
            bottom: window.innerHeight - rect.bottom,
            insetLeft: rect.left,
            insetRight: window.innerWidth - rect.right,
            background: style.backgroundColor,
            shadow: style.boxShadow,
            backdrop: style.backdropFilter,
            padLeft: style.paddingLeft,
            padRight: style.paddingRight,
          };
        });
        const shape = await page.getByTestId(shapeTestId).getAttribute('data-shell-shape');
        return { ...measured, shape };
      };

      await page.goto('/#/fixture/app');
      const conversation = await geometryOf('capsule-shell', 'terminal-capsule');

      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();
      const capability = await geometryOf(
        'workspace-capability-capsule',
        'workspace-capability-capsule',
      );

      // The surface is compared as *computed values on both sides*, not against
      // a literal: the claim is that the two states are one object, and a
      // literal would keep passing if the token behind both of them changed.
      expect(conversation.shape).toBe('capsule');
      expect(capability.shape).toBe('capsule');
      expect(capability.radius).toBe(conversation.radius);
      expect(capability.background).toBe(conversation.background);
      expect(capability.shadow).toBe(conversation.shadow);
      expect(capability.backdrop).toBe(conversation.backdrop);
      expect(capability.padLeft).toBe(conversation.padLeft);
      expect(capability.padRight).toBe(conversation.padRight);

      // …and the geometry the two *land on*. One assertion per axis rather than
      // an object comparison, so a failure names the axis that moved: both
      // states are laid out from the same tokens, and a whole pixel of
      // difference is already the drift this test exists to catch.
      expect(Math.abs(capability.height - conversation.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(capability.bottom - conversation.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(capability.insetLeft - conversation.insetLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(capability.insetRight - conversation.insetRight)).toBeLessThanOrEqual(1);

      // Long labels are containment problems, not outer-geometry variants.
      await page.getByTestId('workspace-tool-env-label').evaluate((node) => {
        node.textContent =
          'Environment Configuration and Runtime Diagnostics with a Deliberately Long Name';
      });
      const longLabelCapability = await geometryOf(
        'workspace-capability-capsule',
        'workspace-capability-capsule',
      );
      expect(Math.abs(longLabelCapability.height - capability.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(longLabelCapability.bottom - capability.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(longLabelCapability.insetLeft - capability.insetLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(longLabelCapability.insetRight - capability.insetRight)).toBeLessThanOrEqual(1);
    });


    test('App Capability Capsule keeps one row under synthetic overflow stress (#1455)', async ({ page }) => {
      await assertCapabilityRowCssStress(page, 'app');
    });

    test('App working state ring is quiet but perceptible (#1455)', async ({ page }) => {
      await assertWorkRingPerceptible(page, '/#/fixture/app?pane=claude.exe');
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

      // The session row's `…` — the menu #1066 was measured on. The capsule's
      // `+` used to be asserted here too, because it opened
      // `CapabilityDisclosureMenu` and was the other list shipping 28px rows
      // inside a 44px floor. It opens the Context Capsule now, which is a
      // Capsule rather than a menu and is held to its own pattern below — so
      // this helper serves real menus only.
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

    test('the Context Capsule is a stacked Capsule, not a menu (#1347 SC-41–44)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
      await expect(page.getByTestId('capsule-capability-more')).toBeVisible();

      await assertContextCapsule(page, 'app', row.id);
    });

    test('the Context Capsule is one height in every sense state (#1347 SC-44)', async ({ page }) => {
      await assertSameHeightAcrossSenseStates(page);
    });

    test('picking an ordinary capability opens its detail, and the Workspace from there', async ({ page }) => {
      await assertRowOpensDetail(page, '/#/fixture/app');
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

      // The capsule is the App's primary input surface, held to the 44px chrome
      // floor — and since the 2026-10-03 Capsule-family decision the Workspace
      // bar shares that floor and the same outer geometry (see the relational
      // assertion above, #1347 SC-30).
      const controls = page.getByTestId('capsule-input-actions').locator('button');
      for (let i = 0; i < (await controls.count()); i += 1) {
        await expectTouchTarget(controls.nth(i), optsFor(PATTERN_TERMINAL_CAPSULE, 'app', row.id));
      }
    });

    test('the terminal grid is drawn inside the surface inset (#1092)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      // Waits for the *sized* terminal, not just for `.xterm-screen` — see the
      // helper. Measuring the pre-fit grid would report the defect itself.
      await waitForFixtureTerminal(page);

      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) {
            return null;
          }
          const b = el.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        };
        return {
          surface: rect('[data-terminal-viewport]'),
          cell: rect('.xterm'),
          screen: rect('.xterm-screen'),
        };
      });
      if (!boxes.surface || !boxes.cell || !boxes.screen) {
        throw new Error('the fixture terminal must lay out a surface, a box and a screen');
      }

      // The grid is sized from the container's *content* box, so it is fitted to
      // the box the inset has already been taken out of. Fitted against the
      // padded box it was not: 373px of screen inside a 362px `.xterm` — 14px of
      // inset on the left, 3px on the right, in every App baseline.
      //
      // The bound is **one column**, not zero, and the reason is a property of
      // the approach rather than of this fix: xterm re-measures its cell while
      // applying the resize, and draws `cols * thatCell`. When the settled cell
      // is a fraction wider than the one the fit divided by, the difference
      // compounds across the column count — measured on CI, a ~0.1px per-column
      // difference over 50 columns is ~3px of overhang, where the same build
      // locally is 2px *inside* the box. The product reads and resizes in the
      // same order (`ResizeController`), so this is not a fixture-only tolerance.
      //
      // One column still separates it from the defect: fitted against the padded
      // box the overhang was ~1.5 columns, because the inset is 28px and
      // FitAddon subtracted only its ~17px scrollbar allowance.
      const measured = await page.evaluate(() => {
        // One character's advance, as the *row's* width over its character
        // count, so nothing here depends on how xterm grouped its markup: it
        // emits one span per styled run, and the runs it finds are not stable
        // across profiles — measured on CI at `app.narrow-phone`, where the
        // App profile renders `$ git status --short` as four spans, so a
        // measurement taken from the first text node found one character where
        // it expected a word.
        //
        // Rows are used only where the text is exactly the rendered text — no
        // leading or trailing space — so the divisor is the glyph count and
        // not the cell count. A row of a monospace grid is uniform, so any
        // such row measures the advance; the longest is taken to average out
        // subpixel rounding.
        const rows = [...document.querySelectorAll('.xterm-rows > div')];
        let best: { text: string; width: number } | null = null;
        for (const row of rows) {
          const text = row.textContent ?? '';
          if (text !== text.trim() || text.length < 12) {
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(row);
          const width = range.getBoundingClientRect().width;
          if (width <= 0) {
            continue;
          }
          if (best === null || text.length > best.text.length) {
            best = { text, width };
          }
        }
        return best === null ? null : best.width / best.text.length;
      });
      if (measured === null) {
        throw new Error('no full-width rendered row to measure a column from');
      }
      // A divisor that is nonsense would make both bounds below meaningless, so
      // it is checked before it is used rather than trusted.
      expect(measured).toBeGreaterThan(2);
      expect(measured).toBeLessThan(20);
      const advance = measured;
      const boxesMessage = `xterm ${boxes.cell.left}..${boxes.cell.right}, screen ${boxes.screen.left}..${boxes.screen.right}, column ${advance}`;
      expect(boxes.screen.left, boxesMessage).toBeGreaterThanOrEqual(boxes.cell.left - advance);
      expect(boxes.screen.right, boxesMessage).toBeLessThanOrEqual(boxes.cell.right + advance);
      // …and the fit is tight: a grid that fitted by a column too few is as
      // wrong as one that fitted by a column too many.
      expect(boxes.screen.right, boxesMessage).toBeGreaterThanOrEqual(boxes.cell.right - advance);

      // Non-vacuity: a screen that "fits" by collapsing to a couple of columns
      // would satisfy the lines above, and so would a terminal whose buffer was
      // never written. Both are ruled out by the content, in the two shapes it
      // takes across the matrix: short lines stay whole on one row, long ones
      // take more rows than the buffer has lines.
      //
      // The line named is the *first* buffer line, 20 columns, because this
      // test runs at every viewport in the matrix and the longest line (52)
      // does not fit the 46 columns `app.narrow-phone` lays out. Asserting the
      // long line whole was what failed there — it holds where the grid is wide,
      // which is a different property from the one under test.
      //
      // The row count is a floor rather than an equality for the same reason:
      // the buffer has 9 non-empty lines, and wrapping only ever adds rows.
      const rows = await page.locator('.xterm-rows > div').allTextContents();
      expect(rows.some((row) => row.includes('$ git status --short'))).toBe(true);
      expect(rows.filter((row) => row.trim() !== '').length).toBeGreaterThanOrEqual(9);
    });

    test('a pushed detail keeps the capsule, and its content clears it (#1347)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      // Push a file detail: this is the App Files flow the owner measured on
      // 2026-10-03 — before the decision, opening a file took the capsule away
      // and left the editor's last line under where it had been.
      await page.getByTestId('file-row-web').click();
      await page.getByTestId('file-row-web/src').click();
      await page.getByTestId('file-row-web/src/App.tsx').click();

      const nav = page.getByTestId('workspace-capability-capsule');
      await expect(nav).toBeVisible();

      // The scroller's reachable end sits above the capsule — the same measured
      // inset the capability root spends, so *any* last line can be brought
      // clear of the bar rather than only short files passing by luck.
      const geometry = await page.evaluate(() => {
        const host = document.querySelector('[data-testid="codemirror-editor"]');
        const capsule = document.querySelector('[data-testid="workspace-capability-capsule"]');
        if (!(host instanceof HTMLElement) || !(capsule instanceof HTMLElement)) {
          return null;
        }
        const padBottom = Number.parseFloat(getComputedStyle(host).paddingBottom);
        const contentBoxBottom = host.getBoundingClientRect().bottom - padBottom;
        return { padBottom, contentBoxBottom, capsuleTop: capsule.getBoundingClientRect().top };
      });
      if (!geometry) {
        throw new Error('the pushed detail must lay out an editor and the capsule');
      }
      expect(geometry.padBottom).toBeGreaterThan(0);
      expect(geometry.contentBoxBottom).toBeLessThanOrEqual(geometry.capsuleTop + 1);
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

      // …and the depth's own leave walks the directory stack (#1140) before the
      // capability root, where Back and the shell both mean the Terminal.
      await back.click();
      await expect(page.getByTestId('app-page-header')).toContainText('src');
      await expect(back).toHaveAttribute('aria-label', 'Back to Files');
      await back.click();
      await expect(page.getByTestId('app-page-header')).toContainText('web');
      await back.click();
      await expect(page.getByTestId('app-page-header')).toContainText('Files');
      await expect(back).toHaveAttribute('aria-label', 'Back to terminal');

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

    test('the capability capsule owns its drag: panning the row never pages (#1347)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();

      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

      // Whether the row overflows is a property of the viewport, not of this
      // rule: at `app.landscape-phone` (844 wide) six slots fit and there is
      // nothing to pan, while the drag below must still be the row's — the
      // entries are controls, not a page-start. So the row's own scroll extent
      // is not asserted; the observable here is the layer.
      const row = page.getByTestId('workspace-capability-scroll');
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      if (!box) {
        throw new Error('the capability row must be laid out');
      }
      const y = Math.round(box.y + box.height / 2);

      // A rightward drag from the middle of the row is the gesture the owner
      // measured on 2026-10-03: the row panned *and* the shell paged back to
      // the Terminal. The row is a work surface now (#1049's exclusion,
      // extended), so the shell must not follow the finger…
      const middle = Math.round(box.x + box.width / 2);
      await swipeHorizontally(page, { y, fromX: middle, toX: middle + 140 });
      await page.waitForTimeout(300);
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

      // …and the shell still pages from a start that IS navigation — its own
      // header band, whose left edge is chrome at every App viewport (the
      // capsule's own left edge is only inside the 28px band in portrait, and
      // the file list swallows the drag in landscape, so neither is a stable
      // anchor here). Without this half, a pager that had simply stopped
      // working would pass the assertion above. The narrower case — the edge
      // band over a work surface — is `#1081`'s test, measured on the xterm.
      const shell = await layerRoot.boundingBox();
      const header = await page.getByTestId('app-header-sessions').boundingBox();
      if (!shell || !header) {
        throw new Error('the App shell and its header must be laid out');
      }
      await swipeHorizontally(page, {
        y: Math.round(header.y + header.height / 2),
        fromX: Math.round(shell.x + 6),
        toX: Math.round(shell.x + 156),
      });
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
    });
  });
}
