// e2e/specs/fixture-git.spec.ts
//
// #750 SC2 and SC5, asserted against real DOM rather than a jsdom mock: the
// listing groups changes and gives an untracked entry no expander, and the view
// carries no control that could ask git to write. #826's History section is
// asserted here too — it reads the log through the same fixture surface.
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

test('a capability earns its slot only when opened or observed', async ({ page }) => {
  // The canonical route does not open Git, and nothing about the session says
  // Git is relevant — so it must not be in direct chrome. This is also why the
  // golden screenshots do not move when a capability is registered.
  await page.goto('/#/fixture/workspace');
  await expect(page.getByTestId('workspace-tool-git')).toHaveCount(0);

  // Opening it gives it the slot it needs, and only that one.
  await gotoGit(page);
  await expect(page.getByTestId('workspace-tool-git')).toBeVisible();
  await expect(page.getByTestId('git-workspace')).toBeVisible();
});

test('changes are grouped, and an untracked entry has no expander (SC2)', async ({ page }) => {
  await gotoGit(page);

  const modified = page.getByTestId('git-group-modified');
  const untracked = page.getByTestId('git-group-untracked');
  await expect(modified).toBeVisible();
  await expect(untracked).toBeVisible();

  // Tracked changes are controls; untracked entries are not — they have no
  // diff to open, so nothing pressable is offered for them.
  await expect(modified.getByTestId('git-row-tracked').first()).toBeVisible();
  await expect(untracked.getByTestId('git-row-untracked').first()).toBeVisible();
  await expect(untracked.locator('button')).toHaveCount(0);
  await expect(untracked.getByTestId('git-row-tracked')).toHaveCount(0);
});

test('opening a changed file shows its diff (SC3)', async ({ page }) => {
  await gotoGit(page);

  await page.getByTestId('git-row-tracked').first().click();
  await expect(page.getByTestId('git-diff')).toBeVisible();
  await expect(page.getByTestId('git-diff-body')).toContainText('@@');
});

test('the view offers no control that could write to the repository (SC5)', async ({ page }) => {
  await gotoGit(page);

  const view = page.getByTestId('git-workspace');
  const openers = view.locator('button[data-path]');
  const controls = view.locator('button');

  // Counted whole rather than grepped for keywords. A test that looked for the
  // word "Commit" would pass the moment someone labelled the button "Stage
  // all"; counting cannot be worded around. The archetype is fixed by the
  // fixture: three tracked changes, each an opener, plus the header's controls —
  // the four section tabs and Refresh.
  await expect(openers).toHaveCount(3);
  await expect(controls).toHaveCount(8);

  // Naming the five that are not file openers is what keeps the count honest.
  // A write affordance cannot hide by being counted as one of them, because
  // these two assertions say exactly which controls the extras are.
  await expect(view.getByTestId('git-refresh')).toHaveCount(1);
  await expect(view.getByRole('tab')).toHaveCount(4);

  await view.getByTestId('git-refresh').click();
  await expect(controls).toHaveCount(8);
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

  // Selecting a commit says which one it is — and says what it is not showing,
  // which is the half a reader would otherwise read as a bug.
  await page.getByTestId('git-commit-row').first().click();
  const detail = page.getByTestId('git-commit-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('not shown here');

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
