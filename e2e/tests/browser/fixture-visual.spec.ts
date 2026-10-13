// #561 Phase 7–8 / #548 — focused visual regression for canonical fixture routes.
// Functional assertions run first; screenshots are the drift gate afterward.
// Baseline update: CI=true npx playwright test fixture-visual --update-snapshots=all
import { expect, test, type Locator } from '@playwright/test';
import { openCapsuleCapability } from '../../helpers/capsule';
import {
  FIXTURE_SCREENSHOT,
  expectChromeRegion,
  freezeFixtureClock,
  gotoFixtureApp,
  gotoFixtureShell,
  gotoFixtureWorkspace,
  openFixtureFile,
  waitForFixtureTerminal,
} from '../../helpers/fixtureVisual';

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
    // The row is already the step to the detail — picking a capability opens
    // it, so there is no title click here any more. Visibility is the whole
    // assertion now: the attribute that used to witness the step
    // (`data-depth`) went with the depth axis, and `git-peek-body` below is
    // what says the open surface is Git's own body rather than the frame.
    await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();

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
        getComputedStyle(document.documentElement).getPropertyValue('--nession-shell-rail-width'),
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
    // --nession-shell-space-2 off the bottom edge, mirroring where the expanded footer
    // carries the same status — not directly under the summaries, which is
    // where a shrink-wrapped nav left it.
    expect(await glyphCenterOffset('sidebar-rail-expand')).toBeLessThanOrEqual(0.5);
    // A custom property's computed value keeps the author's unit, so
    // getPropertyValue('--nession-shell-space-2') reads "0.5rem" and parseFloat makes
    // it 0.5, not 8 (--shell-rail-width above is px-valued, which is why the
    // same trick works there). Measure it through a probe element instead.
    const shellSpace2 = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:absolute;visibility:hidden;height:var(--nession-shell-space-2)';
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
