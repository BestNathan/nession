// #561 Phase 7–8 / #548 — focused visual regression for canonical fixture routes.
// Functional assertions run first; screenshots are the drift gate afterward.
// Baseline update: CI=true npx playwright test fixture-visual --update-snapshots=all
import { expect, test, type Locator } from '@playwright/test';
import {
  FIXTURE_SCREENSHOT,
  freezeFixtureClock,
  gotoFixtureApp,
  gotoFixtureShell,
  gotoFixtureWorkspace,
  openFixtureFile,
  waitForFixtureTerminal,
} from '../helpers/fixtureVisual';

test.skip(!process.env.CI, 'canonical visual regression runs in CI only');

test.beforeEach(async ({ page }) => {
  await freezeFixtureClock(page);
});

/** The field's painted height right now. */
async function fieldHeight(field: Locator): Promise<number> {
  return field.evaluate((el) => el.getBoundingClientRect().height);
}

/**
 * The field's height sampled across one animation frame.
 *
 * The multiline case needs this because the layout attribute it could poll
 * instead (`data-dock-height`) flips on the commit that *starts* the field's
 * height transition (`--motion-terminal-capsule`, ~280ms) rather than when it
 * ends — so a screenshot taken as soon as that attribute moves can catch the
 * capsule mid-growth. Two frames that agree is what "settled" means.
 */
async function fieldHeightAcrossFrame(field: Locator): Promise<[number, number]> {
  return field.evaluate(async (el) => {
    const before = el.getBoundingClientRect().height;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return [before, el.getBoundingClientRect().height];
  });
}

test.describe('Web 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Active Terminal', async ({ page }) => {
    await gotoFixtureShell(page);
    // Above `lg` the sidebar is a column, not an overlay drawer (#748). The
    // drawer-open screen this used to pin is not one the shipped shell has at
    // this width, so the canonical screenshot moves with the shell.
    await expect(page.getByTestId('sidebar-column')).toBeVisible();
    await expect(page.getByTestId('session-drawer')).toHaveCount(0);
    await waitForFixtureTerminal(page);
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('web-active-terminal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Files', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await expect(page.getByTestId('files-web-layout')).toBeVisible();
    // Open a file, so the viewer and the code surface are in the baseline
    // rather than an empty state that covers neither.
    await openFixtureFile(page);

    await expect(page).toHaveScreenshot('web-workspace.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // The Files view *before* anything is opened. `Workspace / Files` above opens
  // a file so the viewer is in its screenshot, which means this state — the
  // tree and the empty detail pane — stopped being captured by anything. Two
  // states, two screenshots: an empty pane is not evidence about a filled one.
  test('Workspace / Files, nothing open', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await expect(page.getByTestId('files-web-layout')).toBeVisible();

    await expect(page).toHaveScreenshot('web-workspace-unopened.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});

test.describe('Web compact 1024×768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('Active Terminal', async ({ page }) => {
    await gotoFixtureShell(page);
    await waitForFixtureTerminal(page);

    await expect(page).toHaveScreenshot('web-compact-terminal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Files', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await expect(page.getByTestId('files-web-layout')).toBeVisible();
    await openFixtureFile(page);

    await expect(page).toHaveScreenshot('web-compact-workspace.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});

test.describe('App 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Active Terminal', async ({ page }) => {
    await gotoFixtureApp(page);
    await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
    await waitForFixtureTerminal(page);

    await expect(page).toHaveScreenshot('app-terminal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #838: a capability emerging beside the capsule. It had no fixture route
  // until the capsule rendered in one — `terminal ?? <TerminalRegion/>` meant
  // neither fixture drew a composer at all.
  test('Capability Signal on the Terminal', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    await page.getByTestId('capsule-capability-more').click();
    await page.getByTestId('capsule-capability-picker-git').click();

    await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
    await expect(page.getByTestId('git-signal-body')).toContainText('worktree: nession-capsule');

    await expect(page).toHaveScreenshot('app-capability-signal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1034's other three capsule states. Resting and the capability Signal were
  // the two with baselines; the entry, Terminal Keys and the multiline composer
  // had none, so a change to any of them had no image that could fail.
  test('Capability entry', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    await page.getByTestId('capsule-capability-more').click();
    // The list is portalled and opens upward (`side="top"`), so this is the
    // assertion that the screenshot below is of an open entry rather than of a
    // capsule whose `+` happened to be tapped.
    await expect(page.getByTestId('capsule-capability-picker-terminal-keys')).toBeVisible();

    await expect(page).toHaveScreenshot('app-capability-entry.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Terminal Keys accessory', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    await page.getByTestId('capsule-capability-more').click();
    await page.getByTestId('capsule-capability-picker-terminal-keys').click();

    // Both halves of §5, and the reason this shot exists: the keys are above a
    // composer that is still there. A baseline of the key row alone would keep
    // passing for a composer that had been replaced by it.
    await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
    await expect(page.getByTestId('capsule-ghost-input')).toBeVisible();

    await expect(page).toHaveScreenshot('app-terminal-keys.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Multiline composer', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    const field = page.getByTestId('capsule-ghost-input');
    // Visible first, so `resting` below is a real single-line height: the
    // settle check compares against it, and a measurement of nothing would make
    // that half of the comparison vacuous.
    await expect(field).toBeVisible();
    const resting = await fieldHeight(field);

    await field.fill('summarize the capsule states\nand what each one covers');

    await expect
      .poll(async () => page.getByTestId('terminal-capsule').getAttribute('data-dock-height'))
      .toBe('multi');

    // Settled *and* grown: a single sample taken before the transition started
    // would agree with itself while still showing the resting height.
    await expect
      .poll(async () => {
        const [before, after] = await fieldHeightAcrossFrame(field);
        return before !== resting && before === after;
      })
      .toBe(true);

    await expect(page).toHaveScreenshot('app-terminal-multiline.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('app-sessions.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Files', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').first().click();
    await expect(page.getByTestId('files-app-layout')).toBeVisible();
    // App pushes the viewer over the tree, so this captures the pushed editor
    // — which no baseline covered either.
    await openFixtureFile(page);

    await expect(page).toHaveScreenshot('app-workspace.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // The App's Files **list**, which is the whole screen before a file is pushed
  // over it. `Workspace / Files` above captures the pushed editor, so the list
  // itself — section header, rows, metas — was in no baseline.
  test('Files list', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').first().click();
    await expect(page.getByTestId('files-app-list')).toBeVisible();
    // The directory counts arrive one `listDir` at a time, so the screenshot
    // waits for the last row's meta rather than racing it.
    await expect(page.getByTestId('file-row-web')).toContainText('1 file', { timeout: 10_000 });

    await expect(page).toHaveScreenshot('app-files-list.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});
