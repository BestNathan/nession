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

  // #1102's second item — `#1046`'s second depth on the Web experience — and
  // with its App counterpart above, criterion 13's "Web/App share capability
  // semantics while geometry differs". That claim is a pair of images: the
  // sequence is identical, the surfaces they land in are not.
  test('Git Peek on the Terminal', async ({ page }) => {
    await gotoFixtureShell(page);
    await waitForFixtureTerminal(page);

    await page.getByTestId('capsule-capability-more').click();
    await page.getByTestId('capsule-capability-picker-git').click();
    // The title is the step from Signal to Peek, and it goes inert once there —
    // so `git-peek-body` below is what says this is a Peek rather than a Signal
    // whose title happened to be tapped.
    await page.getByTestId('capsule-capability-title').click();

    await expect(page.getByTestId('git-peek-body')).toBeVisible();
    // The capability's own Workspace action, which the Host no longer draws
    // (#1046) — the same assertion the App case makes, because it is the same
    // plugin rendering it.
    await expect(page.getByTestId('capsule-capability-open-workspace')).toBeVisible();

    await expect(page).toHaveScreenshot('web-git-peek.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1120 item 12's conversation surfaces, and the first images of any of this:
  // until #1131 served `claude-code.conversation` from the fixture, no route
  // could render a conversation at all, so #1125's readable title and the
  // transcript it heads were in no baseline and the visual gate could not see
  // them. Two states, not one — a list and an open transcript are different
  // screens, and an image of either is not evidence about the other.
  test('Claude Code conversation', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=claude-code');

    await expect(page.getByTestId('claude-code-workspace')).toBeVisible();
    const conversation = page.getByTestId('conversation-open');
    await expect(conversation).toBeVisible();

    // The two assertions an image cannot make for itself, and the reason the
    // fixture carries a *titled* conversation: the header names the work rather
    // than the identity, and the identity has not crept back in as text. The
    // UUID is still reachable as the element's `title`, which is where #1120
    // puts it for Web.
    await expect(conversation).toContainText('Terminal ownership handoff');
    await expect(conversation).not.toContainText('c0a1b2c3-');

    await expect(page).toHaveScreenshot('web-claude-code-conversation.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Claude Code conversation list', async ({ page }) => {
    // `ambiguous`: several conversations at this cwd and no answer about which
    // is the Session's. The fixture names one and leaves another untitled, so
    // both the title and the client's own fallback are in the picture.
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=ambiguous');

    await expect(page.getByTestId('claude-code-workspace')).toBeVisible();
    const list = page.getByTestId('conversation-list');
    await expect(list).toBeVisible();

    await expect(list).toContainText('Terminal ownership handoff');
    await expect(list).toContainText('Capsule radius review');
    // The untitled candidate falls back to a date said as a date.
    await expect(list).toContainText('Conversation ·');

    await expect(page).toHaveScreenshot('web-claude-code-conversations.png', {
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

  // #1082 criterion 13 names 375/390 for the no-Session home. It is a screen in
  // its own right — the App's root before any work exists — and until this
  // route existed no canonical screen could produce it, so the visual gate had
  // nothing to protect.
  test('No Session home', async ({ page }) => {
    await gotoFixtureApp(page, '?selection=none');
    await expect(page.getByTestId('app-home')).toBeVisible();
    // The two routes out are the point of the screen, so they are what has to
    // be in the picture: the primary action, and Sessions.
    await expect(page.getByTestId('app-home-new-session')).toBeEnabled();
    await expect(page.getByTestId('app-header-sessions')).toBeVisible();
    await expect(page.getByTestId('app-header-workspace')).toHaveCount(0);

    await expect(page).toHaveScreenshot('app-home.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1083 §9's two empty states. Neither was reachable before this change:
  // `?selection=none` only deselects and the list still held six rows, and the
  // fixture advertised one online Agent unconditionally — so the screens the
  // issue specifies existed only in the issue. Same reasoning as the no-Session
  // home above: a rendering no route can produce is a rendering nobody checked.
  test('Sessions with no Sessions at all', async ({ page }) => {
    await gotoFixtureApp(page, '?sessions=none');
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    // The empty state is an invitation, and the assertion that it is one is
    // that its action is live — an empty list with a dead button is the status
    // report `visual-language.md` §Empty states replaces.
    await expect(page.getByTestId('app-sessions-empty')).toBeVisible();
    await expect(page.getByTestId('app-sessions-empty-new-session')).toBeEnabled();
    await expect(page.getByTestId('app-sessions-empty-no-agent')).toHaveCount(0);

    await expect(page).toHaveScreenshot('app-sessions-empty.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions with no online Agent', async ({ page }) => {
    await gotoFixtureApp(page, '?sessions=none&agents=offline');
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    // Creation cannot succeed, so the control stays visible and says why. Both
    // halves are asserted: the disabled button alone would photograph the same
    // whether or not the explanation rendered.
    await expect(page.getByTestId('app-sessions-empty-new-session')).toBeDisabled();
    await expect(page.getByTestId('app-sessions-empty-no-agent')).toBeVisible();

    await expect(page).toHaveScreenshot('app-sessions-empty-no-agent.png', {
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

  // #1102: the Peek is the surface #1046 creates — the Signal's second depth —
  // and until this test it was in no image at all. Every capsule state *around*
  // it was captured (the Signal above, the entry and the accessory below) and
  // the one the requirement is about was not, so a regression inside the Peek
  // had nothing that could fail.
  test('Git Peek on the Terminal', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    await page.getByTestId('capsule-capability-more').click();
    await page.getByTestId('capsule-capability-picker-git').click();
    // The title is the step from Signal to Peek, and it goes inert once there —
    // so `git-peek-body` below is what says this is a Peek rather than a Signal
    // whose title happened to be tapped.
    await page.getByTestId('capsule-capability-title').click();

    await expect(page.getByTestId('git-peek-body')).toBeVisible();
    // The capability's own Workspace action, which the Host no longer draws
    // (#1046). An image can show that something is there; this is the assertion
    // that the something is the plugin's, not the frame's.
    await expect(page.getByTestId('capsule-capability-open-workspace')).toBeVisible();

    await expect(page).toHaveScreenshot('app-git-peek.png', {
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

  // #1050 criterion 11's second state. The field filtered nothing until #1050
  // stage 5 — the route passed `searchQuery: ''` and the unfiltered list as
  // static props, so typing into it was a screenshot of nothing happening.
  // `FixtureApp` now composes the product's own filter state
  // (`useDashboardFilter`) and the product's own filter (`filterSessions`), so
  // this is the screen the app produces for this query, and the assertions
  // below the field are what say the list narrowed rather than that the field
  // rendered the text.
  test('Sessions layer, filtered', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    // `filterSessions` matches a Session's name *or* its Agent id, so this keeps
    // the three Sessions on `devbox-01` — including one whose name says nothing
    // about the query, which is the half a name-only search would miss.
    await page.getByPlaceholder('Search sessions...').fill('devbox');

    await expect(page.getByTestId('session-item-row')).toHaveCount(3);
    await expect(page.getByTestId('session-item-devbox-01:design-system')).toBeVisible();
    await expect(page.getByTestId('session-item-macbook:dotfiles')).toHaveCount(0);
    await expect(page.getByTestId('session-item-sg-prod:prod-shell')).toHaveCount(0);

    await expect(page).toHaveScreenshot('app-sessions-filtered.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // The other half of criterion 5, and a state the name `filtered` does not
  // cover: that one types into the field, which is *search*. This one applies a
  // status filter, which is the control #1083 moved behind the field's own
  // trigger — a different control with a different promise, so it earns its own
  // image rather than sharing one.
  //
  // The chip is asserted, not merely photographed. Moving filters behind a
  // trigger is only safe if an applied filter stays *stated* without reopening
  // the panel, and a screenshot cannot say which of the two is carrying that.
  test('Sessions layer, status filter active', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await page.getByTestId('session-list-filters').click();
    const panel = page.getByTestId('session-list-filters-panel');
    await expect(panel).toBeVisible();
    // Scoped to the panel: the chip carries the same word once it exists.
    await panel.getByRole('button', { name: 'Offline', exact: true }).click();

    // `sg-prod` is the one Agent the fixture marks offline, so one row is the
    // product's own answer to this filter, not an arbitrary narrowing. The count
    // is what says the *list* narrowed rather than that a chip appeared.
    await expect(page.getByTestId('session-item-row')).toHaveCount(1);
    await expect(page.getByTestId('session-list-filter-chip')).toContainText('Offline');

    // The panel does not close when a status is chosen — `filtersOpen` is state
    // of its own, and choosing does not touch it. The resting composition is the
    // chip alone, so this click is what reaches it rather than a dismissal the
    // product performs. Recorded here because a golden that opens the panel,
    // picks, and shoots would otherwise pin the panel as part of the state.
    await page.getByTestId('session-list-filters').click();
    await expect(page.getByTestId('session-list-filters-panel')).toHaveCount(0);

    await expect(page).toHaveScreenshot('app-sessions-status-filtered.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // Criterion 7/9's opened form, which #1083's canonical-state list names and
  // the default golden only shows collapsed: there, `Agents · 2 online` is the
  // foot of the list, and what it opens into is in no image at all. Asserting
  // the entry exists is not asserting the destination is reachable, and the
  // entry is the last thing in a scrolling column — the one place it could be
  // expanded and still be off screen.
  test('Sessions layer, Agents expanded', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    const disclosure = page.getByTestId('app-agents-disclosure');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    const agents = page.getByTestId('sidebar-agents');
    await agents.scrollIntoViewIfNeeded();
    await expect(agents).toBeInViewport();
    // Reachability alone is not enough to assert: `scrollIntoViewIfNeeded`
    // would bring an *empty* container into view and every check above would
    // still pass. These rows are what says the expansion produced the
    // destination rather than merely expanding.
    await expect(page.locator('[data-testid^="sidebar-agent-"]')).toHaveCount(3);
    await expect(page.getByTestId('sidebar-agent-sg-prod')).toBeVisible();

    await expect(page).toHaveScreenshot('app-sessions-agents.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // The third state, and the one the fixture cannot produce on its own: an Agent
  // is stale when a *refresh got no answer from it*, so nothing this route does
  // can make one. `?stale=` names that input (`session.stale_agents` in the
  // product) rather than the reading it resolves to, exactly as `?pane=` names a
  // pane's command rather than the capability it emerges — a fixture that could
  // ask for "the degraded row" would assert a state the app never decided on.
  //
  // `macbook` is listed as online and is the Agent that did not answer, so both
  // degraded readings are in one frame: its two Sessions read "Agent did not
  // respond" in the error colour, while `sg-prod`'s keeps the offline one.
  test('Sessions layer, degraded', async ({ page }) => {
    await gotoFixtureApp(page, '?stale=macbook');
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    // Produced by `mapDomainState` from that input, not written here: every
    // Session on a stale Agent carries the line, and the offline Agent's keeps
    // its own reading.
    await expect(page.getByText('Agent did not respond')).toHaveCount(2);
    await expect(page.getByText('Agent offline')).toHaveCount(1);

    await expect(page).toHaveScreenshot('app-sessions-degraded.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1083 §8's other half. "Healthy infrastructure is invisible" was checkable —
  // the resting baselines have no foot — but the half that *renders* something
  // had no route, because both fixture frames hardcoded a connected socket. A
  // region nobody can produce is a region nobody has looked at, which is how
  // the last attempt at this shipped an empty strip.
  test('Sessions layer, link degraded', async ({ page }) => {
    await gotoFixtureApp(page, '?connection=reconnecting');
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    // Asserted, not just photographed: a banner and the state it announces are
    // two different things to get wrong, and the retry is the action the state
    // exists to offer.
    const problem = page.getByTestId('app-sessions-problem');
    await expect(problem).toBeVisible();
    await expect(problem).toContainText('Reconnecting');
    await expect(page.getByLabel('Refresh sessions')).toBeVisible();

    await expect(page).toHaveScreenshot('app-sessions-degraded-link.png', {
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

// #1050 criterion 11 names **375/390**, and until now only 390 had goldens:
// `app.narrow-phone` was exercised by `ui-contract-matrix`'s structured
// assertions but never photographed. The narrowest canonical phone is also the
// one where the App surface has least room, so it is the viewport most worth
// having a picture of rather than only measurements of.
//
// Snapshot names carry the width. Playwright keys snapshots per *file*, so
// reusing `app-sessions.png` here would collide with the 390 case rather than
// produce a second baseline.
test.describe('App 375×812', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('No Session home', async ({ page }) => {
    await gotoFixtureApp(page, '?selection=none');
    await expect(page.getByTestId('app-home')).toBeVisible();

    await expect(page).toHaveScreenshot('app-home-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    await expect(page).toHaveScreenshot('app-sessions-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer, filtered', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    await page.getByPlaceholder('Search sessions...').fill('devbox');
    await expect(page.getByTestId('session-item-row')).toHaveCount(3);

    await expect(page).toHaveScreenshot('app-sessions-filtered-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Sessions layer, degraded', async ({ page }) => {
    await gotoFixtureApp(page, '?stale=macbook');
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();

    await expect(page.getByText('Agent did not respond')).toHaveCount(2);
    await expect(page.getByText('Agent offline')).toHaveCount(1);

    await expect(page).toHaveScreenshot('app-sessions-degraded-375.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});

// #1083 criterion 15 names **844×390 landscape**, and it was the one viewport
// in that criterion with no picture: the structured assertions run there
// (`ui-contract-matrix`'s `app.landscape-phone`), but a measurement is not a
// photograph, and nothing would have failed if the screen stopped *reading*
// like a navigator while still passing every contract.
//
// It is also the viewport where the criterion that removed chrome is most
// visible: it has the least vertical room, so the Filters row, the Refresh
// button and the foot were the largest share of it. Measured before and after
// #1083, the list grew from 193px to 286px here.
test.describe('App 844×390 landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('Sessions layer', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-sessions').first().click();
    await expect(page.getByTestId('app-layer-sessions')).toBeInViewport();
    await expect(page.getByTestId('session-item-row')).toHaveCount(6);

    // The list keeps its floor and stays reachable — the #1057 crisis, which
    // this viewport is the canonical case for. Asserted as well as
    // photographed, because a full-page screenshot of a short viewport cannot
    // show that a scrollable region inside it has height.
    const list = page.getByTestId('app-sessions-list');
    await expect(list).toBeVisible();
    expect((await list.boundingBox())?.height ?? 0).toBeGreaterThan(100);

    await expect(page).toHaveScreenshot('app-sessions-844x390.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });
});
