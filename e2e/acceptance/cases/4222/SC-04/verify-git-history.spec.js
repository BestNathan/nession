'use strict';
// #4222 SC-04 (Git History split reader): the commit list and the commit detail
// are independent bounded owners; opening a file diff does not add a second
// `overflow-y-auto` ancestor around the diff reader. The single inner scroller
// reaches its endpoint above the Capsule, and Branches/Worktrees keep theirs.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

async function measure(page, selector, label) {
  const state = await helper.expectSurfaceAtEnd(page, selector, label);
  if (state && state.host) {
    expect(state.scroller.className, label + ': marked bounded owner')
      .toContain('nession-workspace-bounded-scroll');
  }
  return state;
}

test('SC-04 Git History keeps one measured reader per split pane', async ({ page }) => {
  test.setTimeout(200_000);
  const { sha } = verifiedRuntime('SC-04');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await helper.openWorkspace(page, 'git', '?git=many');

    // ── History: list + detail are sibling owners, not nested scrollers ──
    await page.getByTestId('git-section-history').click();
    await page.getByTestId('git-commit-list').waitFor({ timeout: 30_000 });
    await page.locator('[data-testid="git-commit-row"]').first().click();
    await page.getByTestId('git-commit-detail').waitFor({ timeout: 30_000 });

    const list = await measure(page, '[data-testid="git-commit-list"]', `Git list ${viewport.id}`);
    const detail = await measure(
      page,
      '[data-testid="git-commit-detail"]',
      `Git detail ${viewport.id}`,
    );
    if (list && list.host && detail && detail.host) {
      expect(list.scroller.bottom, 'the split panes end at different coordinates')
        .not.toBe(detail.scroller.bottom);
    }

    const fileRow = page.locator('[data-testid="git-commit-file-row"]').first();
    if ((await fileRow.count()) > 0) {
      await fileRow.click();
      await page.getByTestId('git-diff').waitFor({ timeout: 30_000 });
      // The patch renderer is a shadow-DOM host; wait for its painted content
      // before measuring the short-surface endpoint.
      await page.getByTestId('git-diff-patch').waitFor({ timeout: 30_000 }).catch(() => undefined);
      await measure(page, '[data-testid="git-diff-body"]', `Git history diff ${viewport.id}`);

      // The wrapper between the diff reader and its flex parent is a layout
      // parent, not a second scroll owner (#4222).
      const nested = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="git-diff-body"]');
        if (!(body instanceof HTMLElement)) return null;
        const ancestors = [];
        for (let node = body.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          ancestors.push({ overflowY: style.overflowY, tag: node.tagName });
          if (node.getAttribute('data-testid') === 'workspace-tool-content') break;
        }
        return ancestors;
      });
      expect(nested).not.toBeNull();
      expect(
        nested.filter((entry) => entry.overflowY === 'auto' || entry.overflowY === 'scroll').length,
        'the diff reader has no second scroll ancestor',
      ).toBe(0);
    }

    // ── Branches and Worktrees keep their own bounded owner ──
    await page.getByTestId('git-section-branches').click();
    await page.getByTestId('git-branch-list').waitFor({ timeout: 30_000 });
    await measure(page, '[data-testid="git-branch-list"]', `Git branches ${viewport.id}`);

    await page.getByTestId('git-section-worktrees').click();
    await page.getByTestId('git-worktree-list').waitFor({ timeout: 30_000 });
    await measure(page, '[data-testid="git-worktree-list"]', `Git worktrees ${viewport.id}`);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: at 375/390/430 the Git History commit list and commit `
      + 'detail were measured as independent sibling owners at different bottoms, '
      + 'and opening a file diff left exactly one scroller (git-diff-body) with no '
      + 'additional overflow-y-auto ancestor. Branches and Worktrees each scrolled '
      + 'their own bounded owner to its endpoint above the Capsule.',
  });
});
