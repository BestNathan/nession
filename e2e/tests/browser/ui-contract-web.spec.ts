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

for (const row of viewports.filter((v) => v.experience === 'web')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('session rows stay clipped; workspace capsule shows lifecycle-eligible capabilities', async ({ page }) => {
      await page.goto('/#/fixture');
      await assertSessionRowsClipped(page, 'web', row.id);

      await page.goto('/#/fixture/workspace');
      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();

      // Capsule V2 (#1347 / #1455): the row is scrollable, but hidden /
      // unavailable capabilities do not reserve dead chrome.
      const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
      const allCaps = nav.locator('button[data-testid^="workspace-tool-"]');
      expect(await allCaps.count()).toBeGreaterThan(0);

      for (let i = 0; i < (await allCaps.count()); i += 1) {
        await expect(allCaps.nth(i)).toBeVisible();
        await expectSingleLine(allCaps.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
        await expectVisibleWithin(allCaps.nth(i), bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      }

      const capsule = page.getByTestId('workspace-capability-capsule');
      await expect(capsule).toBeVisible();
      await expectSingleLine(capsule, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      await expectVisibleWithin(capsule, bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));

      // Compact navigation identity is capability-owned. The visual label uses
      // shortTitle while the control's accessible/title identity stays full.
      const env = page.getByTestId('workspace-tool-env');
      await expect(page.getByTestId('workspace-tool-env-label')).toHaveText('Env');
      await expect(env).toHaveAttribute('aria-label', 'Environment');
      await expect(env).toHaveAttribute('title', 'Environment');
      await expect(page.getByTestId('workspace-tool-claude-code-label')).toHaveText('Claude');

      // An unavailable capability is explanatory content only, never a
      // disabled navigation advertisement.
      await page.goto('/#/fixture/workspace?files=unavailable');
      await expect(page.getByTestId('workspace-capability-unavailable')).toBeVisible();
      await expect(page.getByTestId('workspace-tool-files')).toHaveCount(0);
    });

    test('Workspace Capsule keeps one outer height and anchor across state/label changes (#1455)', async ({ page }) => {
      await assertWebCapsuleOuterGeometry(page);
    });

    test('Workspace Capsule production capability set changes horizontal scroll extent only (#1455)', async ({ page }) => {
      await assertProductionCapabilityCountOnlyChangesScrollExtent(page);
    });

    test('destination actions share Capsule material without sharing its radius (#1455)', async ({ page }) => {
      await assertDestinationSharesCapsuleMaterial(
        page,
        '/#/fixture',
        'capsule-shell',
        'surface-action-open-workspace',
      );
      await assertDestinationSharesCapsuleMaterial(
        page,
        '/#/fixture/workspace',
        'workspace-capability-capsule',
        'surface-action-open-terminal',
      );
    });

    test('working state ring is quiet but perceptible (#1455)', async ({ page }) => {
      await assertWorkRingPerceptible(page, '/#/fixture?pane=claude.exe');
    });

    test('workspace capability state does not fork its visual grammar (#1451)', async ({ page }) => {
      await assertWorkspaceEntryStateKeepsVisualGrammar(page);
    });

    test('the Context Capsule is a stacked Capsule, not a menu (#1347 SC-41–44)', async ({ page }) => {
      await page.goto('/#/fixture');
      await expect(page.getByTestId('terminal-capsule')).toBeVisible();

      await assertContextCapsule(page, 'web', row.id);
    });

    test('picking an ordinary capability opens its detail, and the Workspace from there', async ({ page }) => {
      await assertRowOpensDetail(page, '/#/fixture');
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
