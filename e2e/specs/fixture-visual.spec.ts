// #561 Phase 7–8 / #548 — focused visual regression for canonical fixture routes.
// Functional assertions run first; screenshots are the drift gate afterward.
// Baseline update: CI=true npx playwright test fixture-visual --update-snapshots=all
import { expect, test, type Locator } from '@playwright/test';
import { openCapsuleCapability } from '../helpers/capsule';
import {
  FIXTURE_SCREENSHOT,
  expectChromeRegion,
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
    // The row is already the step to Peek — picking a capability opens its
    // detail — so there is no title click here any more. `git-peek-body` is what
    // says this is a Peek rather than a Signal.
    await expect(page.getByTestId('capsule-capability-projection')).toHaveAttribute('data-depth', 'peek');

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

    // And the strip as its own region (#1332). This is the case that found the
    // whole-frame budget blind to exactly this: the strip gained a third tab,
    // the change measured 0.091% of the frame, the comparison passed, and the
    // committed baseline above still showed two tabs.
    await expectChromeRegion(page, 'claude-code-view-tabs', 'web-claude-code-view-tabs.png');
  });

  // #1184's acceptance corpus, in the surface the requirement photographs it
  // from. Each assertion here is a *negative* dialect guarantee — `$HOME` is
  // not a formula, `60~70%` is not strikethrough, `<tool_call>` is not an
  // element — and the canonical conversation contains none of those shapes: a
  // regression that swallowed them would leave every other baseline
  // byte-identical, which is the #714 failure shape this case exists to
  // prevent.
  test('Claude Code conversation, Chat dialect corpus', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=rich');

    await expect(page.getByTestId('claude-code-workspace')).toBeVisible();
    const conversation = page.getByTestId('conversation-open');
    await expect(conversation).toBeVisible();

    // SC-08 / SC-09: shell prose stays prose.
    await expect(conversation).toContainText('$HOME resolved to at launch');
    await expect(conversation).toContainText('$100 in the worst case');
    await expect(conversation).toContainText('~10ms');
    await expect(conversation).toContainText('60~70% of that is the render');
    await expect(conversation.locator('del')).toHaveCount(0);

    // SC-07: the CJK strong run closes where the author closed it.
    await expect(conversation.locator('strong', { hasText: '重点。' })).toBeVisible();

    // SC-10: the tag is literal text on screen.
    await expect(conversation).toContainText('<tool_call>');

    // Both approved math forms render through KaTeX, and nothing errored.
    expect(await conversation.locator('.katex').count()).toBeGreaterThanOrEqual(2);
    await expect(conversation.locator('.katex-error')).toHaveCount(0);

    // SC-18: the alignment markers reach the DOM on every column, and a loose
    // list keeps each item's paragraph while the tight list above it keeps
    // none — a count of 2 is exactly the loose list's two items.
    await expect(conversation.locator('th[align="center"]')).toHaveCount(1);
    await expect(conversation.locator('td[align="right"]')).toHaveCount(2);
    // Scoped to the bullet list: the footnote section is its own `ol` whose
    // body paragraph is also an `li p`.
    await expect(conversation.locator('ul li p')).toHaveCount(2);

    // SC-14: settled resolution — the reference, the footnote and its section.
    await expect(conversation.locator('a[href="https://example.com/nession"]')).toHaveText(
      'stream replay notes',
    );
    await expect(conversation.locator('sup a')).toHaveText('[1]');
    await expect(conversation.locator('[data-footnotes]')).toContainText(
      'Only the attach path is covered',
    );

    // A local destination stays text until a resolver vouches for it.
    await expect(conversation).toContainText('PeekHost.tsx');
    await expect(conversation.locator('a', { hasText: 'PeekHost.tsx' })).toHaveCount(0);

    await expect(page).toHaveScreenshot('web-claude-code-chat-dialect.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Claude Code conversation list', async ({ page }) => {
    // `unbound`: several conversations at this cwd and no answer about which
    // is the Session's. The fixture names one and leaves another untitled, so
    // both the title and the client's own fallback are in the picture.
    await page.goto('/#/fixture/workspace?capability=claude-code&conversation=unbound');

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

  // `#1120`'s last unmet success criterion: "baselines include … and
  // Configuration". It had none because the fixture's Claude Code surface
  // rejected every wire but the conversation one, so this section rendered a
  // transport error on every route and could not be photographed at all.
  //
  // Project is the default scope, so the assertion names a project-only path —
  // a case that only checked "some file is listed" would pass on a section that
  // showed the wrong scope's files.
  test('Claude Code configuration', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=claude-code');

    await expect(page.getByTestId('claude-code-workspace')).toBeVisible();
    await page.getByRole('tab', { name: 'Configuration' }).click();

    await expect(page.getByText('.claude/commands/review.md')).toBeVisible();
    await expect(page.getByText('~/.claude/settings.local.json')).toBeHidden();

    await expect(page).toHaveScreenshot('web-claude-code-configuration.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });

    // The same strip with a different tab selected, so a second baseline rather
    // than a shared one: the highlight is part of the picture, and one state's
    // image is not evidence about another's (#1332). `Claude Code conversation
    // list` is deliberately not asserted — it selects the same tab as the case
    // above, so its region would be that same image, adding baseline surface
    // without adding signal.
    await expectChromeRegion(
      page,
      'claude-code-view-tabs',
      'web-claude-code-view-tabs-configuration.png',
    );
  });

  // #1202 — Environment as a context-first capability. Three states because
  // they are three different claims: the read-first detail is where
  // sensitive-value masking lives, the editor is where the dirty state lives,
  // and the impact dialog is where an in-use save explains itself. One image
  // cannot stand in for the others.
  test('Workspace / Environment', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-list').waitFor();
    await page.getByTestId('env-profile-row-server::staging.env').click();
    // Asserted before the shutter: the masked row is the state this baseline
    // exists to pin, and a screenshot taken against the loading detail would
    // pin nothing.
    await expect(page.getByTestId('env-var-masked-API_KEY')).toBeVisible();
    await expect(page.getByTestId('env-profile-detail')).not.toContainText(
      'staging-secret-9f2c7d',
    );

    await expect(page).toHaveScreenshot('web-env-profile.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Environment, dirty edit', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-list').waitFor();
    await page.getByTestId('env-profile-row-server::staging.env').click();
    await page.getByTestId('env-edit').click();

    await page.locator('.cm-content').click();
    // New line at the doc end — typing straight after the click glues the
    // text onto the last content line.
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('EXTRA=1');
    // The dirty marker is the claim, so it is what the screenshot waits for.
    await expect(page.getByTestId('env-editor-dirty')).toBeVisible();
    await expect(page.getByTestId('env-editor-save')).toBeEnabled();

    await expect(page).toHaveScreenshot('web-env-edit-dirty.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  test('Workspace / Environment, in-use save impact', async ({ page }) => {
    await page.goto('/#/fixture/workspace?capability=env');
    await page.getByTestId('env-profile-list').waitFor();
    await page.getByTestId('env-profile-row-agent:devbox-01:prod.env').click();
    await expect(page.getByTestId('env-profile-usage')).toContainText('api-tests');

    await page.getByTestId('env-edit').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('EXTRA=1');
    await page.getByTestId('env-editor-save').click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Save and update running sessions?');
    await expect(dialog).toContainText('api-tests, deploy');

    await expect(page).toHaveScreenshot('web-env-save-impact.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1196 — the rail is one action plus information summaries, and collapsing
  // is shell geometry (#1195): the column shrinks to the rail width, the work
  // surface reclaims the rest with the Terminal still mounted, and expanding
  // restores both the width and the selection. An image alone cannot say the
  // summaries are not controls or that their counts are truthful, so those are
  // assertions first and a screenshot second.
  test('Sidebar rail', async ({ page }) => {
    await gotoFixtureShell(page);
    await waitForFixtureTerminal(page);

    const railWidth = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--shell-rail-width'),
      ),
    );
    const column = page.getByTestId('sidebar-column');
    const xterm = page.locator('.xterm').first();
    const expandedColumn = (await column.boundingBox())?.width ?? 0;
    const expandedXterm = (await xterm.boundingBox())?.width ?? 0;
    expect(expandedColumn).toBeGreaterThan(railWidth * 2);

    // An icon-only shell button centers its glyph in the box — the shared
    // class owns this, so a raw <button> cannot drift to flush-left while a
    // Button-primitive consumer stays centered (both were shipped once).
    const glyphCenterOffset = async (testid: string) => {
      const button = page.getByTestId(testid);
      const buttonBox = await button.boundingBox();
      const glyphBox = await button.locator('svg').first().boundingBox();
      if (!buttonBox || !glyphBox) throw new Error(`${testid} not measurable`);
      return Math.abs(
        glyphBox.x + glyphBox.width / 2 - (buttonBox.x + buttonBox.width / 2),
      );
    };
    expect(await glyphCenterOffset('sidebar-collapse')).toBeLessThanOrEqual(0.5);

    // Pointer path: the one Collapse control, in the Agents section head.
    await page.getByTestId('sidebar-collapse').click();

    // Geometry: the column is exactly the rail width and the Terminal's own
    // box — not just the flex gap beside it — absorbs the freed width, so the
    // reclaim reached the work surface through the resize pipeline (#1195).
    const collapsedColumn = (await column.boundingBox())?.width ?? 0;
    expect(collapsedColumn).toBe(railWidth);
    await expect
      .poll(async () => (await xterm.boundingBox())?.width ?? 0)
      .toBeGreaterThan(expandedXterm + (expandedColumn - railWidth) * 0.9);
    await expect(xterm).toBeVisible();

    // The return trip is asserted separately — see "expanding the sidebar
    // gives the work surface its width back" in `ui-contract-assertions.spec.ts`
    // (#1269). It is deliberately not a mirror of the assertion above:
    // expanding has to lift a floor that collapsing never touches. `main`
    // defaults to `min-width: auto`, so once the Terminal had rendered at the
    // collapsed width its own grid held the column open, and the row ended up
    // 192px past the viewport while everything in this test still passed.

    // Interactive-role count: one control in the rail, and it is Expand. The
    // summaries are information — present, counted, and not buttons.
    const rail = page.getByTestId('sidebar-rail');
    await expect(rail.getByRole('button')).toHaveCount(1);
    await expect(rail.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    const agentsSummary = page.getByTestId('sidebar-rail-agents');
    await expect(agentsSummary).toHaveText('3');
    await expect(agentsSummary).toHaveAttribute('aria-label', '3 agents · 2 online');
    const sessionsSummary = page.getByTestId('sidebar-rail-sessions');
    await expect(sessionsSummary).toHaveText('6');
    await expect(sessionsSummary).toHaveAttribute('aria-label', '6 sessions');

    // The rail fills the column's full height: the status dot sits one
    // --shell-space-2 off the bottom edge, mirroring where the expanded footer
    // carries the same status — not directly under the summaries, which is
    // where a shrink-wrapped nav left it.
    expect(await glyphCenterOffset('sidebar-rail-expand')).toBeLessThanOrEqual(0.5);
    // A custom property's computed value keeps the author's unit, so
    // getPropertyValue('--shell-space-2') reads "0.5rem" and parseFloat makes
    // it 0.5, not 8 (--shell-rail-width above is px-valued, which is why the
    // same trick works there). Measure it through a probe element instead.
    const shellSpace2 = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:absolute;visibility:hidden;height:var(--shell-space-2)';
      document.body.appendChild(probe);
      const px = probe.getBoundingClientRect().height;
      probe.remove();
      return px;
    });
    const viewportH = page.viewportSize()?.height ?? 0;
    await expect.poll(async () => (await rail.boundingBox())?.height ?? 0).toBe(viewportH);
    // boundingBox is null while the dot is not yet measurable after the
    // collapse swap — poll through it rather than reading once. And it returns
    // {x, y, width, height}, not a DOMRect: the bottom edge is y + height.
    await expect
      .poll(async () => {
        const box = await page.getByTestId('sidebar-rail-status').boundingBox();
        return box
          ? Math.abs(viewportH - shellSpace2 - (box.y + box.height))
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(1);

    await expect(page).toHaveScreenshot('web-sidebar-rail.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });

    // Keyboard path back out: Expand is the rail's one tab stop and activates
    // on Enter. Width and selection both survive the round trip.
    await rail.getByRole('button', { name: 'Expand sidebar' }).focus();
    await page.keyboard.press('Enter');

    expect((await column.boundingBox())?.width ?? 0).toBe(expandedColumn);
    // `data-selected` is on the row wrapper; `aria-current` is on the button
    // inside it — asserting the pair on one element matches nothing.
    await expect(page.locator('[data-testid="session-item-row"][data-selected="true"]')).toHaveCount(1);
    await expect(xterm).toBeVisible();
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

    // A Signal is reached by stepping back out of the Peek now — picking a row
    // opens the detail, so there is no longer a selection that lands on Signal
    // directly. This is also the only place the Signal -> Peek step is exercised
    // in a real browser, so the walk is asserted rather than only photographed.
    await openCapsuleCapability(page, 'git');
    await expect(page.getByTestId('capsule-capability-projection')).toHaveAttribute('data-depth', 'peek');
    await page.getByTestId('capsule-capability-dismiss').click();

    await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
    await expect(page.getByTestId('git-signal-body')).toContainText('worktree: nession-capsule');

    await expect(page).toHaveScreenshot('app-capability-signal.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });

    // …and the title is still the step from Signal to Peek. It goes inert once
    // there, so the depth attribute is what says the step happened.
    await page.getByTestId('capsule-capability-title').click();
    await expect(page.getByTestId('capsule-capability-projection')).toHaveAttribute('data-depth', 'peek');
    await expect(page.getByTestId('git-peek-body')).toBeVisible();
  });

  // #1102: the Peek is the surface #1046 creates — the Signal's second depth —
  // and until this test it was in no image at all. Every capsule state *around*
  // it was captured (the Signal above, the entry and the accessory below) and
  // the one the requirement is about was not, so a regression inside the Peek
  // had nothing that could fail.
  test('Git Peek on the Terminal', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    await openCapsuleCapability(page, 'git');
    // The row is already the step to Peek — picking a capability opens its
    // detail — so there is no title click here any more. `git-peek-body` is what
    // says this is a Peek rather than a Signal.
    await expect(page.getByTestId('capsule-capability-projection')).toHaveAttribute('data-depth', 'peek');

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
    // This is the assertion that the screenshot below is of an open surface
    // rather than of a capsule whose `+` happened to be tapped. On App the list
    // leads with context — Terminal Keys is sensed there (SC-37) — and the
    // ordinary entries follow it in the same list (SC-35 as amended: one list,
    // no second step).
    const sensed = page.getByTestId('capsule-context-item-terminal-keys');
    await expect(sensed).toBeVisible();
    await expect(sensed).toContainText('Touch controls for Terminal');
    await expect(page.getByTestId('capsule-capability-picker-claude-code')).toBeVisible();

    await expect(page).toHaveScreenshot('app-capability-entry.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1347 work-awareness review (2026-10-03): the same `+` while something is
  // working. No canonical route could reach this state — the fixture's selected
  // Session runs `bash` — so `?pane=claude.exe` names the input the work sense
  // resolves from, and the sensed-first Context Disclosure gets coverage that
  // can fail (SC-18/SC-33/SC-35).
  test('Context Disclosure while working: sensed first, anchored, never a modal', async ({ page }) => {
    await gotoFixtureApp(page, '?pane=claude.exe');
    await waitForFixtureTerminal(page);

    // Sensing is ambient: the ring appears, and nothing opens by itself —
    // neither the disclosure nor a Signal for the same observation (SC-34).
    await expect(page.getByTestId('work-ring')).toBeVisible();
    await expect(page.getByTestId('capsule-context-disclosure')).toHaveCount(0);
    await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);

    await page.getByTestId('capsule-capability-more').click();

    // The sensed capability is the first layer, by display identity and reason.
    const sensed = page.getByTestId('capsule-context-item-claude-code');
    await expect(sensed).toBeVisible();
    await expect(sensed).toContainText('Claude Code');
    await expect(sensed).toContainText('Working in this session');
    // The ordinary entries are in this same list rather than a step away
    // (SC-35 as amended).
    await expect(page.getByTestId('capsule-capability-picker-git')).toBeVisible();
    // Nothing about this is a modal: no dialog role, no backdrop (SC-33).
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // …and it is the upper half of a stacked pair rather than a surface parked
    // somewhere else: the gap between it and the Conversation Capsule below it
    // is the inter-Capsule token (#1347 SC-43), and the lower Capsule has not
    // moved to make room (#1347 SC-41).
    const pairGeometry = async () =>
      page.evaluate(() => {
        const surface = document.querySelector('[data-testid="capsule-context-disclosure"]');
        const shell = document.querySelector('[data-testid="capsule-shell"]');
        if (!(surface instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
          return null;
        }
        return {
          gap: shell.getBoundingClientRect().top - surface.getBoundingClientRect().bottom,
          surfaceHeight: surface.getBoundingClientRect().height,
        };
      });

    // 8px is `--context-capsule-margin-bottom` (0.5rem); read as a range so the
    // assertion is about the pair being stacked by a token rather than about a
    // sub-pixel rounding.
    await expect.poll(async () => (await pairGeometry())?.gap ?? -1).toBeGreaterThanOrEqual(7);
    await expect.poll(async () => (await pairGeometry())?.gap ?? -1).toBeLessThanOrEqual(9);

    await expect(page).toHaveScreenshot('app-work-context-disclosure.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });

    // Selecting the sensed row opens its Peek directly — no Signal step (SC-20).
    await sensed.click();
    await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
  });

  test('Terminal Keys Peek', async ({ page }) => {
    await gotoFixtureApp(page);
    await waitForFixtureTerminal(page);

    // The sensed row opens it *directly at Peek* (SC-38): no Signal step and no
    // accessory family — the same sensed -> Context Disclosure -> Peek protocol
    // every other capability walks.
    await page.getByTestId('capsule-capability-more').click();
    await page.getByTestId('capsule-context-item-terminal-keys').click();

    // Both halves of §5, and the reason this shot exists: the keys are above a
    // composer that is still there. A baseline of the key row alone would keep
    // passing for a composer that had been replaced by it.
    const projection = page.getByTestId('capsule-capability-projection');
    await expect(projection).toBeVisible();
    await expect(projection).toHaveAttribute('data-depth', 'peek');
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
    await expect(page.getByTestId('file-row-web')).toContainText('1 item', { timeout: 10_000 });

    await expect(page).toHaveScreenshot('app-files-list.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // #1202's App half: the Environment detail pushed over the navigator. This
  // is the screen that proves the capability navigates through the shell's
  // depth control rather than its own chrome — the header names the profile,
  // and the masked row reads the same as on Web. Driven through the capability
  // picker for the same reason the conversation walk is: the App reaches a
  // capability view that way.
  //
  // The dock used to be asserted *gone* here (#1051). It is present now: owner
  // decision 2026-10-03 — the capsule stays at every Workspace depth, and the
  // depth's scrollers clear it.
  test('Workspace / Environment, pushed detail', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').first().click();
    // The capsule carries the capability list directly since Capsule V2 (#1347);
    // the `+` disclosure it replaced — and its `workspace-capability-picker-*`
    // items — is gone, so the entry is what is clicked.
    await page.getByTestId('workspace-tool-env').click();
    await page.getByTestId('env-profile-list').waitFor();

    await page.getByTestId('env-profile-row-server::staging.env').click();
    await expect(page.getByTestId('app-page-header')).toContainText('staging.env');
    await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();
    await expect(page.getByTestId('env-var-masked-API_KEY')).toBeVisible();

    await expect(page).toHaveScreenshot('app-env-detail.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });
  });

  // The App's half of the conversation coverage. `#1134` gave the Web
  // experience both images — the open transcript and the list — so this is one
  // state in the other experience, which is the half `#1128` means by "in
  // either experience" and the half still in no baseline.
  //
  // Driven through the App's own picker rather than a route parameter: the App
  // reaches a capability view that way, and giving it a `?capability=` would put
  // a test concern into the product's layer state. The end of the walk is
  // asserted rather than assumed, so the shutter cannot catch the Files view the
  // picker would otherwise leave in place.
  test('Claude Code conversation', async ({ page }) => {
    await gotoFixtureApp(page);
    await page.getByTestId('app-header-workspace').first().click();

    // Same reason as the Environment walk above: Capsule V2 (#1347) put the
    // capability list in the capsule and removed the picker.
    await page.getByTestId('workspace-tool-claude-code').click();

    const conversation = page.getByTestId('conversation-open');
    await expect(conversation).toBeVisible();
    // The same two claims `#1134` makes on Web, made here because the App draws
    // this view with its own layout and could regress on its own.
    await expect(conversation).toContainText('Terminal ownership handoff');
    await expect(conversation).not.toContainText('c0a1b2c3-');
    // The tool call is a collapsed row here too (#1005 criterion 10), and the
    // fixture's second one errors — so the failure treatment is in the picture.
    //
    // This transcript's Turn is **working**, not finished: four items follow its
    // last assistant message, one of them a tool that never stopped, and #1409
    // made that mean something — the answer is the last assistant message *no
    // work follows*, so trailing work leaves the Turn open. The process is
    // therefore already expanded and the rows are already on screen. That is
    // what this walk photographs.
    //
    // The settled half — work that has all finished, behind a final answer —
    // is asserted against the fixture's `settled` scenario in
    // `conversation-thread-state.spec.ts`. It used to be asserted *here*, on a
    // transcript that could not reach it, which is a gate that cannot tell
    // "folds correctly" from "never folds" (#1363 round 4).
    await expect(page.getByTestId('conversation-turn-process').first()).toBeVisible();
    await expect(page.getByTestId('conversation-tool').first()).toBeVisible();

    await expect(page).toHaveScreenshot('app-claude-code-conversation.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });

    // The App draws this view with its own layout, so its strip gets its own
    // region rather than borrowing Web's (#1332).
    await expectChromeRegion(page, 'claude-code-view-tabs', 'app-claude-code-view-tabs.png');
  });

  // #1184 SC-16 names the Peek overlay — the conversation read from the
  // Terminal without leaving it — and the narrow viewport the Chat dialect has
  // to stay readable at. Both were in no image at all: the walk below is the
  // only one that opens the overlay, and it is photographed at the canonical
  // 390-wide App size.
  test('Claude Code Peek conversation, Chat dialect corpus', async ({ page }) => {
    await gotoFixtureApp(page, '?conversation=rich');
    await waitForFixtureTerminal(page);

    await openCapsuleCapability(page, 'claude-code');
    // The step to Peek happens on the row itself now — the walk `app-git-peek`
    // documents — and `claude-code-peek-body` below is what says this is a Peek.
    await expect(page.getByTestId('capsule-capability-projection')).toHaveAttribute('data-depth', 'peek');
    await expect(page.getByTestId('claude-code-peek-body')).toBeVisible();

    await expect(page).toHaveScreenshot('app-claude-code-chat-dialect-peek.png', {
      fullPage: true,
      ...FIXTURE_SCREENSHOT,
    });

    await page.getByTestId('claude-code-peek-view-conversation').click();
    const overlay = page.getByTestId('conversation-overlay');
    await expect(overlay).toBeVisible();

    // The same dialect guarantees as Web's case, at 390 wide: prose dollars and
    // tildes intact, the footnote section resolved, math rendered.
    await expect(overlay).toContainText('$HOME resolved to at launch');
    await expect(overlay).toContainText('60~70% of that is the render');
    await expect(overlay.locator('del')).toHaveCount(0);
    await expect(overlay.locator('[data-footnotes]')).toContainText(
      'Only the attach path is covered',
    );
    await expect(overlay.locator('.katex').first()).toBeVisible();
    await expect(overlay.locator('.katex-error')).toHaveCount(0);

    await expect(page).toHaveScreenshot('app-claude-code-chat-dialect.png', {
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
