// e2e/tests/browser/fixture-git.spec.ts
//
// #750 SC5, asserted against real DOM rather than a jsdom mock. #2838 extends
// the same listing to preview untracked and conflicted worktree bytes; #826's
// History section is asserted here too — it reads the log through the same
// fixture surface. #845 adds the three local write units, and the last tests
// assert that the surface offers those and nothing beyond them.
//
// The assertions are shape-based, not copy-based. A test that looked for the
// word "Commit" would pass the moment someone labelled the button "Stage all",
// and would fail on a reworded heading that changed nothing — neither is what
// the criterion is about.
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

async function gotoGit(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/#/fixture/workspace?capability=git');
  // The listing is what the status answer produces, so waiting for it is what
  // makes everything below about a resolved repository rather than a pending one.
  await page.getByTestId('git-change-list').waitFor();
}

test('a registered capability holds a slot without becoming the opened one', async ({ page }) => {
  // Capsule V2 (#1347) keeps a slot for every capability that has a Workspace
  // view, so the canonical route shows Git whether or not it is opened. What
  // separates a registered capability from the opened one is therefore no longer
  // membership but selection — and opening Git must move that selection, and
  // only it.
  await page.goto('/#/fixture/workspace');
  await expect(page.getByTestId('workspace-tool-git')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-git')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('workspace-tool-files')).toHaveAttribute('aria-pressed', 'true');

  await gotoGit(page);
  await expect(page.getByTestId('workspace-tool-git')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('workspace-tool-files')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('git-workspace')).toBeVisible();
});

test('changes are grouped, and every row is an opener (#2838 supersedes #750 SC2)', async ({
  page,
}) => {
  await gotoGit(page);

  const staged = page.getByTestId('git-group-staged');
  const changes = page.getByTestId('git-group-changes');
  const untracked = page.getByTestId('git-group-untracked');
  await expect(staged).toBeVisible();
  await expect(changes).toBeVisible();
  await expect(untracked).toBeVisible();

  // Each group is a control. A staged row opens HEAD→INDEX, an unstaged row
  // opens INDEX→WORKTREE, and an untracked row opens a worktree preview. It is
  // still not pretending an untracked file has a Git baseline.
  await expect(staged.getByTestId('git-row-staged')).toBeVisible();
  await expect(changes.getByTestId('git-row-unstaged').first()).toBeVisible();
  await expect(untracked.getByTestId('git-row-untracked').first()).toBeVisible();
  // Each untracked row is one opener plus its Stage action.
  await expect(untracked.locator('button')).toHaveCount(4);
  await expect(untracked.getByTestId('git-row-staged')).toHaveCount(0);
});

test('untracked and conflicted rows open their worktree bytes (#2838 SC-01/02)', async ({
  page,
}) => {
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const untracked = page.getByTestId('git-row-untracked').filter({ hasText: 'notes/new.ts' });
  await untracked.click();
  await expect(page.getByTestId('git-file-preview')).toBeVisible();
  await expect(page.getByTestId('git-file-preview-path')).toHaveText('notes/new.ts');
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Untracked · File preview (no Git baseline)',
  );
  await expect(page.getByTestId('git-file-preview-text')).toContainText('untracked');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  // One conflicted path is one row; it is not also a modified row.
  const conflict = page.getByTestId('git-row-unmerged').filter({ hasText: 'src/conflict.ts' });
  await expect(conflict).toHaveCount(1);
  await conflict.click();
  await expect(page.getByTestId('git-file-preview-status')).toContainText(
    'Unresolved conflict · File preview',
  );
  await expect(page.getByTestId('git-file-preview-text')).toContainText('<<<<<<< HEAD');
  await expect(page.getByTestId('git-file-preview-text')).toContainText('>>>>>>> other');
  await expect(page.getByTestId('git-file-preview')).toBeVisible();
});

test('preview failures and limits are visible and never fake content (#2838 SC-02/05)', async ({
  page,
}) => {
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = (path: string) => page.getByTestId('git-row-untracked').filter({ hasText: path });

  await row('assets/logo.bin').click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText(
    'Binary file — no text preview.',
  );
  await expect(page.getByTestId('git-file-preview-size')).toContainText('4.0 KB');
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  await row('src/large.txt').click();
  await expect(page.getByTestId('git-file-preview-truncated')).toContainText('4.0 KB');
  await expect(page.getByTestId('git-file-preview-text')).toContainText('first line');

  await row('src/missing.txt').click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText('no longer present');
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  await row('src/moved.txt').click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText(
    'Refresh Git Changes',
  );
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  await row('src/link').click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText(
    'symbolic link',
  );
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  // A tracked path that vanished between listing and selection reports an
  // explicit error instead of a blank or stale diff.
  await page.getByTestId('git-row-unstaged').filter({ hasText: 'src/deleted.ts' }).click();
  await expect(page.getByTestId('git-diff-unavailable')).toContainText('no longer available');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
});

test('an untracked preview is readable at phone width without page clipping (#2838 SC-06)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = page.getByTestId('git-row-untracked').filter({ hasText: 'notes/new.ts' });
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row).toBeFocused();
  await expect(page.getByTestId('git-file-preview-path')).toHaveText('notes/new.ts');
  await expect(page.getByTestId('git-file-preview-text')).toContainText('untracked');
  const body = page.getByTestId('git-file-preview-body');
  await expect(body).toHaveCSS('overflow-y', 'auto');
  expect(
    await body.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
  ).toBeGreaterThan(0);

  // A long preview is scrollable inside its own body, not by moving the shell.
  await page.getByTestId('git-row-untracked').filter({ hasText: 'src/long-preview.txt' }).click();
  await expect(page.getByTestId('git-file-preview-text')).toContainText('line 120');
  const scroll = await body.evaluate((element) => {
    element.scrollTop = 200;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.scrollTop).toBeGreaterThan(0);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const workspace = await page.getByTestId('git-workspace').boundingBox();
  expect(workspace).not.toBeNull();
  expect(workspace?.x ?? 0).toBeGreaterThanOrEqual(0);
  expect((workspace?.x ?? 0) + (workspace?.width ?? 0)).toBeLessThanOrEqual(391);
});

test('opening a changed file renders its patch with line semantics (SC3, #2791 SC-01)', async ({
  page,
}) => {
  await gotoGit(page);

  const row = page.getByTestId('git-row-unstaged').first();
  const path = await row.getAttribute('data-path');
  await row.click();

  await expect(page.getByTestId('git-diff')).toBeVisible();
  await expect(page.getByTestId('git-diff-path')).toHaveText(path ?? '');
  const patch = page.getByTestId('git-diff-patch').locator('diffs-container');
  await expect(patch).toBeVisible();

  // Shadow DOM is where Pierre draws; Playwright's CSS locators pierce it.
  // `single` is the renderer's name for the unified/stacked presentation.
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'single');
  await expect(patch.locator('[data-column-number]').first()).toBeVisible();
  await expect(patch.locator('[data-line][data-line-type="context"]')).not.toHaveCount(0);
  await expect(patch.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(2);
  await expect(patch.locator('[data-line][data-line-type="change-deletion"]')).toHaveCount(1);

  // The layout switch is presentation only: the selected file and the patch
  // stay the same, and the row remains the one current Git identity.
  const unified = page.getByTestId('git-diff-layout-unified');
  const split = page.getByTestId('git-diff-layout-split');
  await expect(unified).toHaveAttribute('aria-pressed', 'true');
  await expect(split).toBeVisible();
  const diffRequests = await page.evaluate(
    () => (window as unknown as { fixtureGitDiffRequests?: readonly string[] }).fixtureGitDiffRequests?.length ?? 0,
  );
  expect(diffRequests).toBeGreaterThan(0);

  await split.focus();
  await expect(split).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'split');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('git-diff-loading')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { fixtureGitDiffRequests?: readonly string[] }).fixtureGitDiffRequests?.length ?? 0,
    ),
  ).toBe(diffRequests);

  await unified.focus();
  await page.keyboard.press('Enter');
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'single');
});

test('binary, empty, mode-only, truncated and malformed answers stay honest (#2791 SC-02)', async ({
  page,
}) => {
  await page.goto('/#/fixture/workspace?capability=git&git=diff-states');
  await page.getByTestId('git-change-list').waitFor();

  const row = (path: string) =>
    page
      .getByTestId('git-row-staged')
      .or(page.getByTestId('git-row-unstaged'))
      .filter({ hasText: path });
  const patch = page.getByTestId('git-diff-patch').locator('diffs-container');

  await row('assets/logo.png').click();
  await expect(page.getByTestId('git-diff-binary')).toContainText('Binary file');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  await row('src/empty.txt').click();
  await expect(page.getByTestId('git-diff-no-changes')).toContainText('No changes to show');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  await row('mode/run.sh').click();
  await expect(page.getByTestId('git-diff-mode-only')).toContainText('100644');
  await expect(page.getByTestId('git-diff-mode-only')).toContainText('100755');
  await expect(page.getByTestId('git-diff-mode-only')).toContainText('No line changes');
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);

  await row('src/large.ts').click();
  await expect(page.getByTestId('git-diff-truncated')).toContainText('4.0 KB');
  await expect(patch.locator('pre[data-diff]')).toBeVisible();
  await expect(patch.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(2);

  await row('src/malformed.ts').click();
  await expect(page.getByTestId('git-diff-fallback')).toBeVisible();
  await expect(page.getByTestId('git-diff-fallback-note')).toContainText(
    'Could not render this diff. Showing the raw patch.',
  );
  await expect(page.getByTestId('git-diff-raw')).toContainText('@@ -1,2 +1,2 @@');
  await expect(page.getByTestId('git-diff-raw')).toContainText('+const after = 2;');
  // No invented rows: the rejected patch is not partially drawn as if complete.
  await expect(page.getByTestId('git-diff-patch')).toHaveCount(0);
  await expect(patch.locator('[data-line][data-line-type="change-addition"]')).toHaveCount(0);
});

test('the diff remains usable at desktop and App-like phone width (#2791 SC-03)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoGit(page);

  await page.getByTestId('git-row-unstaged').first().click();
  await expect(page.getByTestId('git-diff')).toBeVisible();
  const patch = page.getByTestId('git-diff-patch').locator('diffs-container');
  await expect(patch.locator('[data-line]').first()).toBeVisible();

  // Split is not offered where two columns would stop being readable; the
  // one presentation that remains is still the complete patch.
  await expect(page.getByTestId('git-diff-layout')).toHaveCount(0);
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'single');

  const fontSize = await patch
    .locator('[data-line]')
    .first()
    .evaluate((line) => Number.parseFloat(getComputedStyle(line).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(11);

  // Long code scrolls inside the renderer; the Workspace chrome and page must
  // not develop a horizontal clip.
  const code = patch.locator('[data-code]').first();
  const codeScroll = await code.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(['auto', 'scroll']).toContain(codeScroll.overflowX);
  expect(codeScroll.scrollWidth).toBeGreaterThan(codeScroll.clientWidth);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const workspace = await page.getByTestId('git-workspace').boundingBox();
  expect(workspace).not.toBeNull();
  expect(workspace?.x ?? 0).toBeGreaterThanOrEqual(0);
  expect((workspace?.x ?? 0) + (workspace?.width ?? 0)).toBeLessThanOrEqual(391);

  // Desktop offers split, the control is keyboard reachable, and the switch
  // does not leave the page with a new horizontal boundary.
  await page.setViewportSize({ width: 1440, height: 900 });
  const split = page.getByTestId('git-diff-layout-split');
  await expect(split).toBeVisible();
  await split.focus();
  await expect(split).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(patch.locator('pre[data-diff]')).toHaveAttribute('data-diff-type', 'split');
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(desktopOverflow).toBeLessThanOrEqual(1);

  // A change longer than the pane is actually scrollable inside its own body.
  await page.goto('/#/fixture/workspace?capability=git&git=diff-states');
  await page.reload();
  await page.getByTestId('git-change-list').waitFor();
  await page.getByTestId('git-row-unstaged').filter({ hasText: 'src/long.ts' }).click();
  await expect(patch.locator('[data-line]')).toHaveCount(101);
  const longBody = page.getByTestId('git-diff-body');
  await expect(longBody).toHaveCSS('overflow-y', 'auto');
  const longScroll = await longBody.evaluate((element) => {
    element.scrollTop = 200;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(longScroll.scrollHeight).toBeGreaterThan(longScroll.clientHeight);
  expect(longScroll.scrollTop).toBeGreaterThan(0);

  expect(
    await page
      .getByTestId('git-workspace')
      .getByRole('button', { name: /push|pull|fetch|checkout|switch|discard|reset/i })
      .count(),
  ).toBe(0);
});

test('offers the three local writes and nothing beyond them (#845)', async ({ page }) => {
  await gotoGit(page);

  const view = page.getByTestId('git-workspace');

  // Counted by the units they invoke. The default fixture has two unstaged
  // tracked rows and two untracked rows (four Stage actions) and one staged row
  // (one Unstage action).
  await expect(view.getByTestId('git-stage')).toHaveCount(4);
  await expect(view.getByTestId('git-unstage')).toHaveCount(1);
  await expect(view.getByTestId('git-commit-form')).toBeVisible();
  await expect(view.getByTestId('git-commit')).toBeDisabled();

  // A conflicted row is displayed but inert: resolving a merge is not one of
  // the three units. The fixture's default scenario has no conflicts, so open
  // the preview scenario to prove the absence on a conflict that exists.
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();
  await expect(
    page.getByRole('button', { name: /stage src\/conflict\.ts|unstage src\/conflict\.ts/i }),
  ).toHaveCount(0);

  // No remote or history-rewriting operation is expressible in the Git
  // surface. Scoped to the view: the shell's own controls are not Git
  // operations, and counting them made this assertion about the page.
  await expect(
    view.getByRole('button', {
      // Word boundaries: `merge` must not match the path
      // `src/unmerged-missing.ts`, which is a row opener, not a control.
      name: /\b(?:push|pull|fetch|checkout|switch|discard|reset|rebase|merge)\b/i,
    }),
  ).toHaveCount(0);
});

test('stage, confirm, and commit from the Changes surface (#845)', async ({ page }) => {
  await gotoGit(page);

  const target = page.getByTestId('git-row-unstaged').filter({
    hasText: 'web/src/capabilities/git/GitPlugin.ts',
  });
  await target.click();
  await page.getByRole('button', { name: 'Stage web/src/capabilities/git/GitPlugin.ts' }).click();

  // The row moved from Changes to Staged; the post-state came from the agent
  // answer, not from an optimistic guess.
  await expect(
    page.getByTestId('git-group-staged').getByText('web/src/capabilities/git/GitPlugin.ts'),
  ).toBeVisible();

  await page.getByTestId('git-commit-message').fill('feat(git): stage from the workspace');
  await expect(page.getByTestId('git-commit')).toBeEnabled();

  // Commit is heavier than stage: it opens a confirmation naming what will run.
  await page.getByTestId('git-commit').click();
  await expect(page.getByTestId('git-commit-dialog')).toBeVisible();
  await expect(page.getByTestId('git-commit-dialog')).toContainText('hooks');
  await page.getByTestId('git-commit-confirm').click();

  // The fixture's commit clears the staged rows and reports a new state; the
  // commit form disappears with the last staged file.
  await expect(page.getByTestId('git-group-staged')).toHaveCount(0);
  await expect(page.getByTestId('git-commit-form')).toHaveCount(0);
});

test('History bounds what it offers, and unmounts the section it replaced (#826)', async ({
  page,
}) => {
  await gotoGit(page);
  await expect(page.getByTestId('git-change-list')).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();

  await expect(page.getByTestId('git-commit-row')).toHaveCount(3);
  // The fixture's repository has three commits; the agent's default count is
  // 50. So this is the whole history, and the view must not offer "older
  // commits" over a log that ends there.
  await expect(page.getByTestId('git-history-more')).toHaveCount(0);

  // Selecting a commit says which one it is — and what it changed. The detail
  // used to carry a note that it was *not* showing the change ("What this commit
  // changed is not shown here"), which is what this assertion used to check;
  // #1009/#1010 made it show the files, so the assertion follows the view rather
  // than the copy that is gone.
  await page.getByTestId('git-commit-row').first().click();
  const detail = page.getByTestId('git-commit-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('let a capability emerge beside the capsule');
  await expect(detail).toContainText('Changed files');

  // A file selected in the commit detail opens the same patch renderer, now
  // bounded by the commit's diff request rather than the working tree's.
  await page.getByTestId('git-commit-file-row').first().click();
  await expect(page.getByTestId('git-diff-patch').locator('diffs-container')).toBeVisible();

  // Unmounted rather than hidden: a hidden section would have its own hook
  // fetching on mount, so the Changes list would still be there paying for a
  // status read nobody is looking at.
  await expect(page.getByTestId('git-change-list')).toHaveCount(0);
});

test('Branches tells apart the states that arrive identically (#846)', async ({ page }) => {
  await gotoGit(page);
  await page.getByRole('tab', { name: 'Branches' }).click();

  // The fixture's four branches are one of each state the view must have an
  // answer for, current first — the order the agent's `--sort=-HEAD` produces.
  const rows = page.getByTestId('git-branch-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toHaveAttribute('data-current', 'true');
  await expect(page.locator('[data-testid="git-branch-row"][data-current="true"]')).toHaveCount(
    1,
  );

  // "In sync" and "no upstream" are `ahead: 0, behind: 0` on the wire, and they
  // are different sentences on screen. This is the assertion that would fail if
  // the view ever rendered the counts alone.
  const text = await page.getByTestId('git-branch-list').innerText();
  expect(text).toContain('origin/main');
  expect(text).toContain('No upstream');
  expect(text).toContain('upstream deleted');

  // Four branches against a default of a hundred is a complete answer.
  await expect(page.getByTestId('git-branches-more')).toHaveCount(0);
});

test('Worktrees marks the Session’s own checkout (#846)', async ({ page }) => {
  await gotoGit(page);
  await page.getByRole('tab', { name: 'Worktrees' }).click();

  const rows = page.getByTestId('git-worktree-row');
  await expect(rows).toHaveCount(3);
  await expect(
    page.locator('[data-testid="git-worktree-row"][data-current="true"]'),
  ).toHaveCount(1);

  // A prunable entry names a directory that is not there. It has to say so, or
  // the row reads as somewhere the user could go.
  await expect(page.getByTestId('git-worktree-prunable')).toHaveCount(1);

  // And the section that was showing is unmounted, so its own request is not
  // running behind this one.
  await expect(page.getByTestId('git-change-list')).toHaveCount(0);
  await expect(page.getByTestId('git-branch-list')).toHaveCount(0);
});
