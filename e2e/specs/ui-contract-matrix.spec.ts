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
  expectSingleLine,
  expectTouchTarget,
  expectVisibleWithin,
} from '../helpers/ui-assert/assertions';
import { loadContracts, type Experience } from '../helpers/ui-assert/contracts';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const { viewports } = loadContracts();

const PATTERN_SESSION_ITEM = 'pattern.session-item';
const PATTERN_WORKSPACE_NAV = 'pattern.workspace-navigation';

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

    test('session rows stay clipped; workspace strip entries are single-line inside the bar', async ({ page }) => {
      await page.goto('/#/fixture');
      await assertSessionRowsClipped(page, 'web', row.id);

      await page.goto('/#/fixture/workspace');
      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();
      for (const tool of ['files', 'session', 'agent', 'env', 'claude-code']) {
        const button = page.getByTestId(`workspace-tool-${tool}`);
        await expect(button).toBeVisible();
        await expectSingleLine(button, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
        await expectVisibleWithin(button, bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      }
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

// ── App experience (Mobile Web proxy, interaction/app.md) ──────────────────

for (const row of viewports.filter((v) => v.experience === 'app')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

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
  });
}
