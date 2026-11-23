'use strict';
// #4188 SC-01 (Git bounded collections): at the canonical App phone widths, a
// long Branches and Worktrees listing scrolls its own declared bounded owner to
// the end, leaves the final row entirely above the real Capsule top, spends the
// host-published inset, and keeps working after switching sections.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

const BRANCH_LIST = '[data-testid="git-branch-list"]';
const WORKTREE_LIST = '[data-testid="git-worktree-list"]';

test('SC-01 Git Branches and Worktrees reach their end above the Capsule', async ({ page }) => {
  test.setTimeout(160_000);
  const { sha } = verifiedRuntime('SC-01');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await helper.openWorkspace(page, 'git', '?git=long-lists');

    // ── Branches ──
    await page.getByRole('tab', { name: 'Branches' }).click();
    await page.getByTestId('git-branch-list').waitFor({ timeout: 30_000 });
    const branches = await helper.scrollToEndAndMeasure(page, BRANCH_LIST);
    helper.expectEndpoint(branches, `Git Branches ${viewport.id}`);
    helper.expectHostInset(branches, `Git Branches ${viewport.id}`);
    expect(branches.host.mode, 'Git is a declared bounded surface').toBe('bounded');
    expect(branches.scroller.className).toContain('nession-workspace-bounded-scroll');
    expect(branches.scroller.testid).toBe('git-branch-list');
    expect(branches.lastContent, 'the final branch row is painted').not.toBeNull();

    // ── Worktrees ──
    await page.getByRole('tab', { name: 'Worktrees' }).click();
    await page.getByTestId('git-worktree-list').waitFor({ timeout: 30_000 });
    const worktrees = await helper.scrollToEndAndMeasure(page, WORKTREE_LIST);
    helper.expectEndpoint(worktrees, `Git Worktrees ${viewport.id}`);
    helper.expectHostInset(worktrees, `Git Worktrees ${viewport.id}`);
    expect(worktrees.host.mode, 'Git is a declared bounded surface').toBe('bounded');
    expect(worktrees.scroller.className).toContain('nession-workspace-bounded-scroll');
    expect(worktrees.scroller.testid).toBe('git-worktree-list');
    expect(worktrees.lastContent, 'the final worktree row is painted').not.toBeNull();

    // ── Section switch keeps a functional scroll ──
    await page.getByRole('tab', { name: 'Branches' }).click();
    await page.getByTestId('git-branch-list').waitFor({ timeout: 30_000 });
    const again = await helper.scrollToEndAndMeasure(page, BRANCH_LIST);
    helper.expectEndpoint(again, `Git Branches after switch ${viewport.id}`);
    expect(again.scroller.scrollTop, 'the re-mounted list still reaches its end')
      .toBe(again.scroller.maxScroll);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the long `git=long-lists` Branches '
      + 'and Worktrees sections each scrolled their own declared bounded owner to '
      + 'maxScroll; the final painted row was no lower than the Capsule top (1px '
      + 'tolerance), the host scroll inset matched its own surface-to-bar '
      + 'geometry, neither document nor body scrolled and no horizontal overflow '
      + 'appeared; switching sections remounted a list that still reached its end.',
  });
});
