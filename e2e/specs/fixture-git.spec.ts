// e2e/specs/fixture-git.spec.ts
//
// #750 SC2 and SC5, asserted against real DOM rather than a jsdom mock: the
// listing groups changes and gives an untracked entry no expander, and the view
// carries no control that could ask git to write.
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
  // fixture: three tracked changes, each an opener, plus one other control.
  await expect(openers).toHaveCount(3);
  await expect(controls).toHaveCount(4);

  // The one control that is not a file opener is Refresh — a read.
  await expect(view.getByTestId('git-refresh')).toHaveCount(1);
  await view.getByTestId('git-refresh').click();
  await expect(controls).toHaveCount(4);
});
