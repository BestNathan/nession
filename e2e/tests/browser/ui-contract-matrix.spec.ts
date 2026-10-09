// e2e/tests/browser/ui-contract-matrix.spec.ts
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
  expectDrawnAffordance,
  expectNoUnexpectedOverflow,
  expectMaxWidth,
  expectPaddingX,
  expectRadius,
  expectSingleLine,
  expectTokenHeight,
  expectTokenMaxHeight,
  expectTouchTarget,
  expectTouchTargetsWithin,
  expectVisibleWithin,
  waitForSettledBox,
} from '../../helpers/ui-assert/assertions';
import { loadContracts, patternBlock, type Experience } from '../../helpers/ui-assert/contracts';
import { swipeHorizontally } from '../../helpers/shell';
import { waitForFixtureTerminal } from '../../helpers/fixtureVisual';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const { viewports } = loadContracts();

const PATTERN_SESSION_HEADER = 'pattern.session-header';
const PATTERN_SESSION_ITEM = 'pattern.session-item';
const PATTERN_WORKSPACE_NAV = 'pattern.workspace-navigation';
const PATTERN_TERMINAL_CAPSULE = 'pattern.terminal-capsule';
const PATTERN_POPUP_MENU = 'pattern.popup-menu';
const PATTERN_CONTEXT_CAPSULE = 'pattern.context-capsule';

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

/**
 * Open the list behind `trigger` and hold it to `pattern.popup-menu` (#1066).
 *
 * The list is the one control surface no other assertion in this file can
 * reach: base-ui mounts it on `<body>`, so it is a sibling of `#root` rather
 * than a descendant of the bar, band or row it was opened from. That is also why
 * it used to render at the wrong density — it inherited from `:root` instead of
 * from the `[data-experience]` scope its trigger sits in — and why the contract
 * is measured on the *items*: `expectTokenHeight` on the menu would only say how
 * tall the box is.
 *
 * Both experiences call this. On Web the touch floor is a no-op by contract
 * (`experience.web` declares no `touchTargetToken`) and the height assertion
 * pins the 28px rows Web already had, so "the App stops inheriting Web's, and
 * Web does not adopt App's" is checked from both sides.
 */
async function assertPopupMenu(
  page: import('@playwright/test').Page,
  experience: Experience,
  viewportId: string,
  trigger: import('@playwright/test').Locator,
): Promise<void> {
  const opts = optsFor(PATTERN_POPUP_MENU, experience, viewportId);

  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // `toBeVisible` resolves on the animation's first frame, where a 44px row
  // measures 43.57px. Measured, not assumed: the floor is pixel-exact, so the
  // read has to come from a settled frame (see `waitForSettledBox`).
  await waitForSettledBox(menu);

  const items = menu.getByRole('menuitem');
  const count = await items.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    await expectTokenHeight(items.nth(i), opts);
    await expectSingleLine(items.nth(i), opts);
  }
  await expectNoUnexpectedOverflow(menu, opts);

  // The items *are* the controls; the menu is only their box. A height check on
  // the menu passes for a list of 32px rows in a 340px column, which is the
  // shape this pattern exists to forbid.
  await expectTouchTargetsWithin(menu, opts);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

async function upperCapsuleVisualSignature(
  surface: import('@playwright/test').Locator,
): Promise<{
  backgroundColor: string;
  borderRadius: string;
  borderTopWidth: string;
  boxShadow: string;
  backdropFilter: string;
  marginBottom: string;
}> {
  return surface.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      backdropFilter: style.backdropFilter,
      marginBottom: style.marginBottom,
    };
  });
}

/**
 * Open the Context Capsule from `+` and hold it to `pattern.context-capsule`
 * (#1347 SC-41–44).
 *
 * Four claims, and the last two are the ones the criteria are actually about:
 *
 * 1. the surface is within the contract's height CEILING and shorter than it, so
 *    it is sized by its content rather than by a box — with the contract's
 *    radius, padding and row band. A Capsule, not a menu;
 * 2. it owns its own scroll, so a long list scrolls rather than pushing the
 *    Capsule Zone around;
 * 3. every row is exactly one row band, so the list does not change rhythm with
 *    the sense state;
 * 4. opening it does not move the Conversation Capsule below it, and the gap
 *    between the two *is* the inter-Capsule token. The lower capsule's box is
 *    read before and after, because "it stays put" is the criterion and a
 *    screenshot cannot prove a negative.
 */
async function assertContextCapsule(
  page: import('@playwright/test').Page,
  experience: Experience,
  viewportId: string,
): Promise<void> {
  const opts = optsFor(PATTERN_CONTEXT_CAPSULE, experience, viewportId);
  const block = patternBlock(PATTERN_CONTEXT_CAPSULE, experience);

  const shellBefore = await page.getByTestId('capsule-shell').boundingBox();
  expect(shellBefore).not.toBeNull();

  await page.getByTestId('capsule-capability-more').click();

  const surface = page.getByTestId('capsule-context-disclosure');
  await expect(surface).toBeVisible();
  await waitForSettledBox(surface);

  await expectTokenMaxHeight(surface, opts);
  await expectRadius(surface, opts);
  await expectPaddingX(surface, opts);
  await expectNoUnexpectedOverflow(surface, opts);

  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  // The half `expectTokenMaxHeight` structurally cannot see. A surface whose
  // content is taller than its ceiling measures the ceiling whether the class is
  // `max-h-` or `h-`, so "at most the ceiling" passes on a fixed height too —
  // and this fixture lists three capabilities, well under the ceiling, so a
  // content-sized surface comes in strictly shorter. If this ever fails, either
  // the fixture grew past the ceiling (adjust the assertion, deliberately) or
  // `max-h-` quietly became `h-` again, which is the regression it exists for.
  expect(block.maxHeightTokenPx).toBeDefined();
  expect(surfaceBox!.height).toBeLessThan(block.maxHeightTokenPx!);

  // …and the same fact from inside: the list is not scrolling, because it is
  // exactly as tall as what it holds rather than as tall as a box.
  const scrolls = await page
    .getByTestId('capsule-context-scroll')
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls).toBe(false);

  const rows = surface.locator('[data-context-row]');
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  for (let i = 0; i < rowCount; i += 1) {
    // One band, not "at least one band". This used to be a `>=` with the comment
    // "growing for that is the design", and that was wrong twice over: the
    // pattern doc lists rows of unequal height as an anti-pattern ("so the list
    // does not jitter between sense states"), and the row's two lines only
    // overflowed the band because no leading was set — 48px against 44px, which
    // the fixed surface height used to hide. Now that the height is a ceiling
    // the difference would show up between sense states, so the band is asserted
    // as a band.
    const box = await rows.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.height - (block.rowHeightTokenPx ?? 0))).toBeLessThanOrEqual(1);
    await expectTouchTargetsWithin(rows.nth(i), opts);
  }

  // Every row's *title* starts at the same column. The row boxes cannot say
  // this: `rows` selects the row button, and every row is a `w-full` sibling of
  // the one scroll container, so their `x` is one number by construction — an
  // assertion on it passes for any markup, including the markup this check
  // exists to catch. The ragged edge was inside the row: with the marker column
  // rendered only on ordinary rows, a sensed row's title sat at x=44 and an
  // ordinary one's at x=50 — the 5px marker column plus one
  // `--terminal-capsule-control-gap` — and nothing measured it. The title span
  // now follows that column on every row (`ContextCapsule.tsx`), so comparing
  // the titles is the assertion that would have failed then. The 1px tolerance
  // is for fractional layout rounding; the defect it guards is a whole column
  // wide.
  let firstTitleLeft: number | null = null;
  for (let i = 0; i < (await rows.count()); i += 1) {
    const titleBox = await rows.nth(i).getByTestId('capsule-row-title').boundingBox();
    expect(titleBox).not.toBeNull();
    firstTitleLeft ??= titleBox!.x;
    expect(Math.abs(titleBox!.x - firstTitleLeft)).toBeLessThanOrEqual(1);
  }

  // The lower Capsule is the anchor: same box, and the gap between the two is
  // the token rather than a measured guess (#1347 SC-41/SC-43).
  const shellAfter = await page.getByTestId('capsule-shell').boundingBox();
  expect(shellAfter).toEqual(shellBefore);

  // The upper slot is the shell's column, not the dock's whole width. On Web
  // the second dock column belongs to the Workspace destination circle; a
  // surface spanning it reads as a panel rather than the Conversation
  // Capsule's upper half (#1446 SC-07). App has no adjacent action, so the same
  // relational assertion naturally reduces to full-width alignment there.
  expect(Math.abs(surfaceBox!.x - shellAfter!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(surfaceBox!.width - shellAfter!.width)).toBeLessThanOrEqual(1);

  // The gap *is* the surface's own bottom margin — read from the element and
  // compared to the space actually measured. No literal: the claim is that the
  // distance between the pair is the token applied to the upper surface, not
  // something the dock's layout contributed, and that is exactly what a
  // measured-gap-equals-computed-margin comparison says. A second claim rides
  // along: the margin is not zero, so the two surfaces are not touching.
  const marginBottomPx = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="capsule-context-disclosure"]');
    return el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).marginBottom) : Number.NaN;
  });
  expect(marginBottomPx).toBeGreaterThan(0);
  const gap = shellAfter!.y - (surfaceBox!.y + surfaceBox!.height);
  expect(Math.abs(gap - marginBottomPx)).toBeLessThanOrEqual(1);

  await page.keyboard.press('Escape');
  await expect(surface).toHaveCount(0);
  // Closing removes only the upper Capsule.
  expect(await page.getByTestId('capsule-shell').boundingBox()).toEqual(shellBefore);
}

// ── Web experience ─────────────────────────────────────────────────────────

/**
 * The upper surface's own box in one fixture route, opened from `+` and closed
 * again, so two states can be compared without a reload in between.
 */
async function contextCapsuleBoxInState(
  page: import('@playwright/test').Page,
  route: string,
): Promise<{ width: number; height: number }> {
  await page.goto(route);
  await expect(page.getByTestId('capsule-capability-more')).toBeVisible();
  await page.getByTestId('capsule-capability-more').click();

  const surface = page.getByTestId('capsule-context-disclosure');
  await expect(surface).toBeVisible();
  await waitForSettledBox(surface);

  const box = await surface.boundingBox();
  expect(box).not.toBeNull();

  await page.keyboard.press('Escape');
  await expect(surface).toHaveCount(0);

  return { width: box!.width, height: box!.height };
}

/**
 * SC-44, asserted rather than assumed.
 *
 * "Work/no-work/context-only use the exact same upper Capsule shell, geometry,
 * animation and dismissal behavior" used to be true *by construction*: the
 * surface's height was a token, so no state could change it and no test needed
 * to say so. Now the height is a ceiling, and the property rests on an
 * invariant instead — the flat list renders every capability, so the states
 * differ in row ORDER and never in row COUNT — which means nothing enforces it
 * unless a test does.
 *
 * The App routes are the ones that can express the difference. On App a Session
 * always senses Terminal Keys, so `/#/fixture/app` has one sensed row (two lines)
 * and `?pane=claude.exe` adds a second; before the row-band fix those rows
 * measured 48px against an ordinary row's 44, so the two states came out 4px
 * apart. Web cannot vary its sense state at all — the Web fixture drives no
 * pane command and never senses Terminal Keys — so this runs where it can.
 */
async function assertSameHeightAcrossSenseStates(
  page: import('@playwright/test').Page,
): Promise<void> {
  const contextOnly = await contextCapsuleBoxInState(page, '/#/fixture/app');
  const working = await contextCapsuleBoxInState(page, '/#/fixture/app?pane=claude.exe');

  expect(working).toEqual(contextOnly);
}

/**
 * Picking a row opens the detail, and the detail is where the Workspace is
 * reached from.
 *
 * This is the assertion the interaction change exists for, and it is written
 * against an ORDINARY row on purpose: `select()` used to route a sensed row to
 * the Peek and an ordinary row to the Signal, so the ordinary row is the half
 * that was wrong. `capsule-capability-open-workspace` is drawn only at Peek
 * depth, so asserting it is visible is the same claim as "the workspace is one
 * step from here" — and on the old code this row produced a Signal with no
 * destination at all.
 */
async function assertRowOpensDetail(
  page: import('@playwright/test').Page,
  route: string,
): Promise<void> {
  await page.goto(route);
  await expect(page.getByTestId('capsule-capability-more')).toBeVisible();
  await page.getByTestId('capsule-capability-more').click();

  const surface = page.getByTestId('capsule-context-disclosure');
  await expect(surface).toBeVisible();
  await waitForSettledBox(surface);

  const contextBox = await surface.boundingBox();
  const shellBefore = await page.getByTestId('capsule-shell').boundingBox();
  expect(contextBox).not.toBeNull();
  expect(shellBefore).not.toBeNull();
  const contextVisual = await upperCapsuleVisualSignature(surface);

  const ordinary = surface.locator('[data-context-row="ordinary"]').first();
  await expect(ordinary).toBeVisible();
  await ordinary.click();

  const peek = page.getByTestId('capsule-capability-projection');
  await expect(peek).toBeVisible();
  await waitForSettledBox(peek);

  // Context -> Peek is a depth/content transition inside ONE upper product
  // surface. Height/content may change; family geometry and material may not.
  const peekBox = await peek.boundingBox();
  expect(peekBox).not.toBeNull();
  expect(Math.abs(peekBox!.x - contextBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(peekBox!.width - contextBox!.width)).toBeLessThanOrEqual(1);
  expect(await upperCapsuleVisualSignature(peek)).toEqual(contextVisual);
  expect(await page.getByTestId('capsule-shell').boundingBox()).toEqual(shellBefore);

  // Git and Claude Code have Workspace views, so one of them is always reachable
  // here; Terminal Keys would not be, and has no business being the first
  // ordinary row.
  await expect(page.getByTestId('capsule-capability-open-workspace')).toBeVisible();
}

async function assertWorkspaceEntryStateKeepsVisualGrammar(
  page: import('@playwright/test').Page,
): Promise<void> {
  const signatureForFiles = async (route: string, expectedPressed: 'true' | 'false') => {
    await page.goto(route);
    const target = page.getByTestId('workspace-tool-files');
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute('aria-pressed', expectedPressed);
    // The label is the only direct span. A second anonymous span here would
    // reintroduce the detached selected dot #1458 removes.
    await expect(target.locator(':scope > span')).toHaveCount(1);
    await waitForSettledBox(target);

    return target.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const label = node.querySelector('[data-testid$="-label"]');
      const labelStyle = label instanceof HTMLElement ? getComputedStyle(label) : null;
      return {
        geometry: {
          width: rect.width,
          height: rect.height,
          borderRadius: style.borderRadius,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          fontSize: labelStyle?.fontSize ?? null,
          fontWeight: labelStyle?.fontWeight ?? null,
          lineHeight: labelStyle?.lineHeight ?? null,
        },
        visual: {
          background: style.backgroundColor,
          foreground: style.color,
        },
      };
    });
  };

  // FixtureWorkspace derives the active capability from the URL and deliberately
  // supplies a no-op onToolChange. Compare the SAME Files entry across two
  // canonical routes instead of pretending the fixture owns interactive routing:
  // default => Files active; ?capability=git => Files inactive.
  const active = await signatureForFiles('/#/fixture/workspace', 'true');
  const inactive = await signatureForFiles('/#/fixture/workspace?capability=git', 'false');

  // Selection is state, not a new component recipe. Geometry and typography
  // remain identical; only the Nession-owned semantic entry surface/foreground
  // acknowledge selection.
  expect(inactive.geometry).toEqual(active.geometry);
  expect(active.visual.background).not.toBe(inactive.visual.background);
  expect(active.visual.foreground).not.toBe(inactive.visual.foreground);
}


async function capsuleOuterBox(
  locator: import('@playwright/test').Locator,
): Promise<{ height: number; bottom: number }> {
  await expect(locator).toBeVisible();
  await waitForSettledBox(locator);
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      bottom: window.innerHeight - rect.bottom,
    };
  });
}

async function captureProductionWorkspaceCapabilityRow(
  page: import('@playwright/test').Page,
  route: string,
): Promise<{
  outer: { height: number; bottom: number };
  ids: string[];
  states: string[];
  row: {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
    contentWidth: number;
    flexWrap: string;
  };
}> {
  await page.goto(route);

  const capsule = page.getByTestId('workspace-capability-capsule');
  const scroll = page.getByTestId('workspace-capability-scroll');
  const outer = await capsuleOuterBox(capsule);
  const ids = await scroll.locator('button[data-testid^="workspace-tool-"]').evaluateAll((nodes) =>
    nodes.map((node) => (node.getAttribute('data-testid') ?? '').replace('workspace-tool-', '')),
  );
  const states = await scroll.locator('button[data-testid^="workspace-tool-"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-capability-state') ?? ''),
  );
  const row = await scroll.evaluate((node) => {
    const entries = Array.from(
      node.querySelectorAll<HTMLElement>('button[data-testid^="workspace-tool-"]'),
    );
    const first = entries[0]?.getBoundingClientRect();
    const last = entries.at(-1)?.getBoundingClientRect();
    return {
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      contentWidth: first && last ? last.right - first.left : 0,
      flexWrap: getComputedStyle(node).flexWrap,
    };
  });

  return { outer, ids, states, row };
}

async function assertProductionCapabilityCountOnlyChangesScrollExtent(
  page: import('@playwright/test').Page,
): Promise<void> {
  // Keep the real Web composition, but make the available band narrow enough
  // that the registered capability set must exercise the row's overflow path.
  // This is still registry -> state -> presence -> Workspace presentation ->
  // binding -> CapabilityCapsule; no DOM entries are manufactured by the test.
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: originalViewport?.height ?? 800 });

  const reduced = await captureProductionWorkspaceCapabilityRow(
    page,
    '/#/fixture/workspace?files=unavailable',
  );
  const full = await captureProductionWorkspaceCapabilityRow(page, '/#/fixture/workspace');

  expect(reduced.ids).toEqual(['session', 'agent', 'env', 'claude-code', 'git']);
  expect(full.ids).toEqual(['files', 'session', 'agent', 'env', 'claude-code', 'git']);
  expect(full.ids.length).toBeGreaterThan(2);
  expect(full.ids.length).toBe(reduced.ids.length + 1);
  expect(full.states.every((state) => state !== 'unavailable')).toBe(true);

  // More eligible, view-bound capabilities extend only the row's horizontal
  // content/scroll axis. The Capsule keeps one row and one vertical object.
  expect(reduced.row.flexWrap).toBe('nowrap');
  expect(full.row.flexWrap).toBe('nowrap');
  expect(full.row.contentWidth).toBeGreaterThan(reduced.row.contentWidth);
  expect(full.row.scrollWidth).toBeGreaterThan(reduced.row.scrollWidth);
  expect(full.row.scrollWidth).toBeGreaterThan(full.row.clientWidth);
  expect(Math.abs(full.row.scrollHeight - reduced.row.scrollHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(full.row.clientHeight - reduced.row.clientHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(full.outer.height - reduced.outer.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(full.outer.bottom - reduced.outer.bottom)).toBeLessThanOrEqual(1);

  if (originalViewport) {
    await page.setViewportSize(originalViewport);
  }
}

async function assertCapabilityRowCssStress(
  page: import('@playwright/test').Page,
  experience: 'web' | 'app',
): Promise<void> {
  if (experience === 'app') {
    await page.goto('/#/fixture/app');
    await page.getByTestId('app-header-workspace').first().click();
    await expect(page.getByTestId('files-app-layout')).toBeVisible();
  } else {
    await page.goto('/#/fixture/workspace');
  }

  const capsule = page.getByTestId('workspace-capability-capsule');
  const scroll = page.getByTestId('workspace-capability-scroll');
  const beforeOuter = await capsuleOuterBox(capsule);
  const before = await scroll.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    childCount: node.children.length,
    flexWrap: getComputedStyle(node).flexWrap,
  }));

  // Supplemental CSS stress only. SC-20 is proved above through the production
  // registry/presence/presentation/binding path; these clones intentionally do
  // not count as product-path evidence.
  await scroll.evaluate((node) => {
    const entries = Array.from(node.children);
    for (let batch = 0; batch < 3; batch += 1) {
      for (const entry of entries) {
        const clone = entry.cloneNode(true) as HTMLElement;
        clone.removeAttribute('id');
        clone.removeAttribute('data-testid');
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('tabindex', '-1');
        node.appendChild(clone);
      }
    }
  });

  await expect.poll(async () => scroll.evaluate((node) => node.scrollWidth))
    .toBeGreaterThan(before.scrollWidth);

  const afterOuter = await capsuleOuterBox(capsule);
  const after = await scroll.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    childCount: node.children.length,
    flexWrap: getComputedStyle(node).flexWrap,
  }));

  expect(before.flexWrap).toBe('nowrap');
  expect(after.flexWrap).toBe('nowrap');
  expect(after.childCount).toBeGreaterThan(before.childCount);
  expect(after.scrollWidth).toBeGreaterThan(before.scrollWidth);
  expect(Math.abs(after.scrollHeight - before.scrollHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.clientHeight - before.clientHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterOuter.height - beforeOuter.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterOuter.bottom - beforeOuter.bottom)).toBeLessThanOrEqual(1);
}

async function assertWebCapsuleOuterGeometry(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.goto('/#/fixture');
  const conversation = await capsuleOuterBox(page.getByTestId('capsule-shell'));

  const lifecycle = [
    {
      state: 'available',
      route: '/#/fixture/workspace?capability=claude-code&pane=zsh',
    },
    {
      state: 'relevant',
      route: '/#/fixture/workspace?capability=claude-code&pane=zsh&observed=claude.exe',
    },
    {
      state: 'active',
      route: '/#/fixture/workspace?capability=claude-code&pane=claude.exe',
    },
  ] as const;

  let lifecycleBaseline: { height: number; bottom: number } | null = null;
  for (const probe of lifecycle) {
    await page.goto(probe.route);
    const entry = page.getByTestId('workspace-tool-claude-code');
    await expect(entry).toHaveAttribute('data-capability-state', probe.state);
    await expect(entry).toHaveAttribute('aria-pressed', 'true');

    const box = await capsuleOuterBox(page.getByTestId('workspace-capability-capsule'));
    expect(Math.abs(box.height - conversation.height)).toBeLessThanOrEqual(1);
    if (lifecycleBaseline) {
      expect(Math.abs(box.height - lifecycleBaseline.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.bottom - lifecycleBaseline.bottom)).toBeLessThanOrEqual(1);
    } else {
      lifecycleBaseline = box;
    }
  }

  if (!lifecycleBaseline) {
    throw new Error('the lifecycle fixture must produce a Workspace Capsule');
  }

  // Selection is a separate axis from lifecycle state (#1458). Switch the
  // selected capability and prove the outer object still keeps its geometry.
  await page.goto('/#/fixture/workspace?capability=git');
  const switched = await capsuleOuterBox(page.getByTestId('workspace-capability-capsule'));
  expect(Math.abs(switched.height - lifecycleBaseline.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(switched.bottom - lifecycleBaseline.bottom)).toBeLessThanOrEqual(1);

  // Deliberately force a label far beyond the slot. Normal capability identity
  // is bounded by shortTitle now; this keeps truncation as the final defensive
  // geometry guard rather than the naming strategy.
  await page.getByTestId('workspace-tool-env-label').evaluate((node) => {
    node.textContent =
      'Environment Configuration and Runtime Diagnostics with a Deliberately Long Name';
  });
  const longLabel = await capsuleOuterBox(page.getByTestId('workspace-capability-capsule'));
  expect(Math.abs(longLabel.height - lifecycleBaseline.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(longLabel.bottom - lifecycleBaseline.bottom)).toBeLessThanOrEqual(1);
}

async function assertDestinationSharesCapsuleMaterial(
  page: import('@playwright/test').Page,
  route: string,
  capsuleTestId: string,
  actionTestId: string,
): Promise<void> {
  await page.goto(route);
  const capsule = page.getByTestId(capsuleTestId);
  const action = page.getByTestId(actionTestId);
  await expect(capsule).toBeVisible();
  await expect(action).toBeVisible();

  const signature = async (locator: import('@playwright/test').Locator) =>
    locator.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        shadow: style.boxShadow,
        backdrop: style.backdropFilter,
        height: rect.height,
        y: rect.y,
      };
    });

  const capsuleVisual = await signature(capsule);
  const actionVisual = await signature(action);

  expect(actionVisual.background).toBe(capsuleVisual.background);
  expect(actionVisual.shadow).toBe(capsuleVisual.shadow);
  expect(actionVisual.backdrop).toBe(capsuleVisual.backdrop);
  expect(Math.abs(actionVisual.height - capsuleVisual.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(actionVisual.y - capsuleVisual.y)).toBeLessThanOrEqual(1);
}

async function assertWorkRingPerceptible(
  page: import('@playwright/test').Page,
  route: string,
): Promise<void> {
  await page.goto(route);
  const ring = page.getByTestId('work-ring');
  await expect(ring).toBeVisible();

  const signal = await ring.locator('circle').evaluate((node) => {
    const style = getComputedStyle(node);
    const surface = document.querySelector<HTMLElement>('[data-testid="capsule-shell"]');
    if (!surface) throw new Error('capsule-shell not found');

    // Chromium preserves modern CSS colors such as oklch() in computed style.
    // Rasterize a 1px fill so the browser performs the CSS Color -> device-sRGB
    // conversion before applying the WCAG relative-luminance calculation.
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2d canvas context unavailable');

    const toRgb = (value: string): [number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const luminance = (value: string): number => {
      const [r, g, b] = toRgb(value).map((part) => {
        const channel = part / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const color = style.color;
    const surfaceColor = getComputedStyle(surface).backgroundColor;
    const lighter = Math.max(luminance(color), luminance(surfaceColor));
    const darker = Math.min(luminance(color), luminance(surfaceColor));

    return {
      color,
      surfaceColor,
      contrastRatio: (lighter + 0.05) / (darker + 0.05),
      animationName: style.animationName,
    };
  });

  // The ring is non-text state UI; 3:1 keeps the signal deliberately quiet
  // while making perceptibility an executable relationship rather than merely
  // proving the two CSS strings are not identical.
  expect(signal.contrastRatio).toBeGreaterThanOrEqual(3);
  expect(signal.animationName).toBe('none');
}

for (const row of viewports.filter((v) => v.experience === 'web')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('session rows stay clipped; workspace capsule shows lifecycle-eligible capabilities', async ({ page }) => {
      await page.goto('/#/fixture');
      await assertSessionRowsClipped(page, 'web', row.id);

      await page.goto('/#/fixture/workspace');
      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();

      // Capsule V2 (#1347 / #1455): the row is scrollable, but hidden /
      // unavailable capabilities do not reserve dead chrome.
      const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
      const allCaps = nav.locator('button[data-testid^="workspace-tool-"]');
      expect(await allCaps.count()).toBeGreaterThan(0);

      for (let i = 0; i < (await allCaps.count()); i += 1) {
        await expect(allCaps.nth(i)).toBeVisible();
        await expectSingleLine(allCaps.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
        await expectVisibleWithin(allCaps.nth(i), bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      }

      const capsule = page.getByTestId('workspace-capability-capsule');
      await expect(capsule).toBeVisible();
      await expectSingleLine(capsule, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));
      await expectVisibleWithin(capsule, bar, optsFor(PATTERN_WORKSPACE_NAV, 'web', row.id));

      // Compact navigation identity is capability-owned. The visual label uses
      // shortTitle while the control's accessible/title identity stays full.
      const env = page.getByTestId('workspace-tool-env');
      await expect(page.getByTestId('workspace-tool-env-label')).toHaveText('Env');
      await expect(env).toHaveAttribute('aria-label', 'Environment');
      await expect(env).toHaveAttribute('title', 'Environment');
      await expect(page.getByTestId('workspace-tool-claude-code-label')).toHaveText('Claude');

      // An unavailable capability is explanatory content only, never a
      // disabled navigation advertisement.
      await page.goto('/#/fixture/workspace?files=unavailable');
      await expect(page.getByTestId('workspace-capability-unavailable')).toBeVisible();
      await expect(page.getByTestId('workspace-tool-files')).toHaveCount(0);
    });

    test('Workspace Capsule keeps one outer height and anchor across state/label changes (#1455)', async ({ page }) => {
      await assertWebCapsuleOuterGeometry(page);
    });

    test('Workspace Capsule production capability set changes horizontal scroll extent only (#1455)', async ({ page }) => {
      await assertProductionCapabilityCountOnlyChangesScrollExtent(page);
    });

    test('destination actions share Capsule material without sharing its radius (#1455)', async ({ page }) => {
      await assertDestinationSharesCapsuleMaterial(
        page,
        '/#/fixture',
        'capsule-shell',
        'surface-action-open-workspace',
      );
      await assertDestinationSharesCapsuleMaterial(
        page,
        '/#/fixture/workspace',
        'workspace-capability-capsule',
        'surface-action-open-terminal',
      );
    });

    test('working state ring is quiet but perceptible (#1455)', async ({ page }) => {
      await assertWorkRingPerceptible(page, '/#/fixture?pane=claude.exe');
    });

    test('workspace capability state does not fork its visual grammar (#1451)', async ({ page }) => {
      await assertWorkspaceEntryStateKeepsVisualGrammar(page);
    });

    test('the Context Capsule is a stacked Capsule, not a menu (#1347 SC-41–44)', async ({ page }) => {
      await page.goto('/#/fixture');
      await expect(page.getByTestId('terminal-capsule')).toBeVisible();

      await assertContextCapsule(page, 'web', row.id);
    });

    test('picking an ordinary capability opens its detail, and the Workspace from there', async ({ page }) => {
      await assertRowOpensDetail(page, '/#/fixture');
    });

    test('terminal capsule controls hold the control token height', async ({ page }) => {
      await page.goto('/#/fixture');
      await assertCapsuleControls(page, 'web', row.id);
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

// ── Terminal capsule — the Session's primary input surface ─────────────────

/**
 * `pattern.terminal-capsule` was the one pattern with no matrix row. It appeared
 * exactly once under `e2e/`, in a self-test of the assertion helper that runs
 * against synthetic DOM, so its contract — including the `overflow` strategy —
 * had never been checked against a real screen. Adding the capsule to the
 * fixture is what made these assertions possible.
 */
async function assertCapsuleControls(
  page: import('@playwright/test').Page,
  experience: Experience,
  viewportId: string,
): Promise<void> {
  await expect(page.getByTestId('terminal-capsule')).toBeVisible();

  // The composer's own row is a control band: one line, at the experience's
  // `control.md`. It is the assertion that makes "one visual row at rest" — the
  // App capsule's whole anatomy — executable rather than prose. It was a
  // two-row field-first stack on App (92px against a 44px band) and nothing
  // said so.
  await expectTokenHeight(page.getByTestId('capsule-input-row'),
    optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));

  const band = page.getByTestId('capsule-input-actions');
  await expect(band).toBeVisible();
  await expectTokenHeight(band, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  await expectSingleLine(band, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  await expectNoUnexpectedOverflow(band, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));

  // §Visual contract, promoted from prose to assertions (#825 Goal 2):
  // "capsule radius from semantic design tokens" and "exact spacing and
  // alignment". Both were unverifiable before — the contract had no field for
  // either, so nothing could fail when they drifted.
  const shell = page.getByTestId('capsule-shell');
  await expect(shell).toBeVisible();
  await expectRadius(shell, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  await expectPaddingX(shell, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  // §Web vs App: "centered with a bounded max width". Asserts the *frame*
  // (which carries the bound), not the inner shell. No-op on App, whose block
  // has no maxWidthToken — the doc bounds the Web placement only.
  await expectMaxWidth(page.getByTestId('terminal-capsule'),
    optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));

  const controls = band.locator('button');
  expect(await controls.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await controls.count()); i += 1) {
    const control = controls.nth(i);
    await expect(control).toBeVisible();
    await expectTokenHeight(control, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
    // Both axes of a control (#1034), measured as the contract splits them: the
    // hit target above, and the affordance painted inside it here. The second
    // call is not a duplicate of the first — on App both tokens are 44px, so the
    // height check alone cannot tell a 44px control holding a 36px circle from
    // one that filled its box, and the matrix is where that would go unnoticed.
    await expectDrawnAffordance(control, optsFor(PATTERN_TERMINAL_CAPSULE, experience, viewportId));
  }
}

// ── App experience (Mobile Web proxy, interaction/app.md) ──────────────────

for (const row of viewports.filter((v) => v.experience === 'app')) {
  test.describe(`${row.id} ${row.width}×${row.height}`, () => {
    test.use({ viewport: { width: row.width, height: row.height } });

    test('workspace capsule shows lifecycle-eligible capabilities in the App bar', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();

      const bar = page.getByTestId('workspace-tool-bar');
      await expect(bar).toBeVisible();

      // Capsule V2 (#1347 / #1455): eligible capability slots scroll inside one fixed band.
      const nav = page.getByRole('navigation', { name: 'Workspace capabilities' });
      const allCaps = nav.locator('button[data-testid^="workspace-tool-"]');
      expect(await allCaps.count()).toBeGreaterThan(0);

      // The entries carry the standard App control band — the pattern declares
      // no compact override since the 2026-10-03 Capsule-family decision — so
      // the contract's resolved target is the chrome floor (44px). Their
      // visibility is asserted on the *capsule container* below, not per
      // entry: six labeled slots are wider than a phone, and the row scrolling
      // internally instead of cramming is exactly what SC-06 requires, so an
      // entry scrolled out of the capsule's viewport is the design working.
      for (let i = 0; i < (await allCaps.count()); i += 1) {
        await expect(allCaps.nth(i)).toBeAttached();
        await expectTouchTarget(allCaps.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
        await expectSingleLine(allCaps.nth(i), optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      }

      const capsule = page.getByTestId('workspace-capability-capsule');
      await expect(capsule).toBeVisible();
      await expectTouchTarget(capsule, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      await expectSingleLine(capsule, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));
      await expectVisibleWithin(capsule, bar, optsFor(PATTERN_WORKSPACE_NAV, 'app', row.id));

      const env = page.getByTestId('workspace-tool-env');
      await expect(page.getByTestId('workspace-tool-env-label')).toHaveText('Env');
      await expect(env).toHaveAttribute('aria-label', 'Environment');
      await expect(env).toHaveAttribute('title', 'Environment');
      await expect(env.locator(':scope > span')).toHaveCount(1);
    });

    test('the two App Capsule states are one family (#1347 SC-30)', async ({ page }) => {
      // SC-30 exists because per-state verification stayed green while the two
      // states drifted apart: 22px semantic radius over a 44/36 control band on
      // the Conversation Form, a 9999px pill over a 28px dock on the Capability
      // Form. This is the relational assertion — both states measured in one
      // scenario and compared to each other, so a change that moves only one of
      // them fails here even though both still "pass" alone.
      //
      // Height IS compared, and that is a correction (owner, 2026-10-03): the
      // first labeled build let the entries carry their own vertical mass, the
      // form grew to 82px over the composer's 56, and it read as a different
      // object in the same slot. The entries now take the canonical
      // `control.md` band directly, so content cannot reinterpret that height
      // as a floor and grow the Capsule.
      // The shape attribute sits on each state's own outer object — the
      // Conversation dock (`terminal-capsule`) and the capability nav.
      //
      // Every axis the criterion names is read here, not just the three it
      // started with: SC-29/30 say surface, elevation, radius, vertical mass,
      // inset and spacing rhythm, and the two states drifting on *shadow* or
      // *padding* while radius and height still matched would have passed the
      // first version of this test.
      const geometryOf = async (testId: string, shapeTestId: string) => {
        const el = page.getByTestId(testId);
        await expect(el).toBeVisible();
        const measured = await el.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            radius: style.borderRadius,
            height: rect.height,
            bottom: window.innerHeight - rect.bottom,
            insetLeft: rect.left,
            insetRight: window.innerWidth - rect.right,
            background: style.backgroundColor,
            shadow: style.boxShadow,
            backdrop: style.backdropFilter,
            padLeft: style.paddingLeft,
            padRight: style.paddingRight,
          };
        });
        const shape = await page.getByTestId(shapeTestId).getAttribute('data-shell-shape');
        return { ...measured, shape };
      };

      await page.goto('/#/fixture/app');
      const conversation = await geometryOf('capsule-shell', 'terminal-capsule');

      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();
      const capability = await geometryOf(
        'workspace-capability-capsule',
        'workspace-capability-capsule',
      );

      // The surface is compared as *computed values on both sides*, not against
      // a literal: the claim is that the two states are one object, and a
      // literal would keep passing if the token behind both of them changed.
      expect(conversation.shape).toBe('capsule');
      expect(capability.shape).toBe('capsule');
      expect(capability.radius).toBe(conversation.radius);
      expect(capability.background).toBe(conversation.background);
      expect(capability.shadow).toBe(conversation.shadow);
      expect(capability.backdrop).toBe(conversation.backdrop);
      expect(capability.padLeft).toBe(conversation.padLeft);
      expect(capability.padRight).toBe(conversation.padRight);

      // …and the geometry the two *land on*. One assertion per axis rather than
      // an object comparison, so a failure names the axis that moved: both
      // states are laid out from the same tokens, and a whole pixel of
      // difference is already the drift this test exists to catch.
      expect(Math.abs(capability.height - conversation.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(capability.bottom - conversation.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(capability.insetLeft - conversation.insetLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(capability.insetRight - conversation.insetRight)).toBeLessThanOrEqual(1);

      // Long labels are containment problems, not outer-geometry variants.
      await page.getByTestId('workspace-tool-env-label').evaluate((node) => {
        node.textContent =
          'Environment Configuration and Runtime Diagnostics with a Deliberately Long Name';
      });
      const longLabelCapability = await geometryOf(
        'workspace-capability-capsule',
        'workspace-capability-capsule',
      );
      expect(Math.abs(longLabelCapability.height - capability.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(longLabelCapability.bottom - capability.bottom)).toBeLessThanOrEqual(1);
      expect(Math.abs(longLabelCapability.insetLeft - capability.insetLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(longLabelCapability.insetRight - capability.insetRight)).toBeLessThanOrEqual(1);
    });


    test('App Capability Capsule keeps one row under synthetic overflow stress (#1455)', async ({ page }) => {
      await assertCapabilityRowCssStress(page, 'app');
    });

    test('App working state ring is quiet but perceptible (#1455)', async ({ page }) => {
      await assertWorkRingPerceptible(page, '/#/fixture/app?pane=claude.exe');
    });

    test('session rows meet the App touch target and stay clipped', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-sessions').first().click();
      const rows = page.getByTestId('session-item-row');
      await expect(rows.first()).toBeInViewport();
      for (let i = 0; i < 6; i += 1) {
        await expectTouchTarget(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, 'app', row.id));
        await expectNoUnexpectedOverflow(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, 'app', row.id));
        // The row is not its controls (#1066). The two assertions above measure
        // the row's own box — 374×60, comfortably over the floor — and so kept
        // passing while the App drew 32px Settings/Kill icons inside it. This is
        // the one that enumerates them.
        await expectTouchTargetsWithin(rows.nth(i), optsFor(PATTERN_SESSION_ITEM, 'app', row.id));
      }
    });

    test('a collapsed control opens a menu of App-density rows', async ({ page }) => {
      await page.goto('/#/fixture/app');

      // The session row's `…` — the menu #1066 was measured on. The capsule's
      // `+` used to be asserted here too, because it opened
      // `CapabilityDisclosureMenu` and was the other list shipping 28px rows
      // inside a 44px floor. It opens the Context Capsule now, which is a
      // Capsule rather than a menu and is held to its own pattern below — so
      // this helper serves real menus only.
      await page.getByTestId('app-header-sessions').first().click();
      const rowLocator = page.getByTestId('session-item-row').first();
      await expect(rowLocator).toBeVisible();
      await assertPopupMenu(
        page,
        'app',
        row.id,
        rowLocator.getByRole('button', { name: /^Session actions for/ }),
      );
    });

    test('the Context Capsule is a stacked Capsule, not a menu (#1347 SC-41–44)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();
      await expect(page.getByTestId('capsule-capability-more')).toBeVisible();

      await assertContextCapsule(page, 'app', row.id);
    });

    test('the Context Capsule is one height in every sense state (#1347 SC-44)', async ({ page }) => {
      await assertSameHeightAcrossSenseStates(page);
    });

    test('picking an ordinary capability opens its detail, and the Workspace from there', async ({ page }) => {
      await assertRowOpensDetail(page, '/#/fixture/app');
    });

    test('terminal capsule controls meet the App touch target', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await assertCapsuleControls(page, 'app', row.id);

      // The App capsule at rest is one row — `[+] [ intent ] [send]` — and its
      // controls share that band with the field rather than sitting beneath it.
      // So there is no second row to trade against, and the field keeps the
      // width it has by not wrapping an action into it: the anchoring assertion
      // is the row height `assertCapsuleControls` now measures, and this is the
      // anatomy that has to stay true for it to hold.
      const more = page.getByTestId('capsule-capability-more');
      await expect(more).toBeVisible();
      await expectTouchTarget(more, optsFor(PATTERN_TERMINAL_CAPSULE, 'app', row.id));

      // Exactly one action beside the field: the primary send. App carries no
      // permanent history, paste, copy or mode control — the capsule is an
      // intent composer, not a terminal toolbar.
      await expect(page.getByTestId('capsule-input-actions').locator('button')).toHaveCount(1);
      for (const absent of [
        'capsule-history-trigger',
        'capsule-paste',
        'capsule-copy',
        'capsule-mode-toggle',
      ]) {
        await expect(page.getByTestId(absent)).toHaveCount(0);
      }

      // The capsule is the App's primary input surface, held to the 44px chrome
      // floor — and since the 2026-10-03 Capsule-family decision the Workspace
      // bar shares that floor and the same outer geometry (see the relational
      // assertion above, #1347 SC-30).
      const controls = page.getByTestId('capsule-input-actions').locator('button');
      for (let i = 0; i < (await controls.count()); i += 1) {
        await expectTouchTarget(controls.nth(i), optsFor(PATTERN_TERMINAL_CAPSULE, 'app', row.id));
      }
    });

    test('the terminal grid is drawn inside the surface inset (#1092)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      // Waits for the *sized* terminal, not just for `.xterm-screen` — see the
      // helper. Measuring the pre-fit grid would report the defect itself.
      await waitForFixtureTerminal(page);

      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) {
            return null;
          }
          const b = el.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        };
        return {
          surface: rect('[data-terminal-viewport]'),
          cell: rect('.xterm'),
          screen: rect('.xterm-screen'),
        };
      });
      if (!boxes.surface || !boxes.cell || !boxes.screen) {
        throw new Error('the fixture terminal must lay out a surface, a box and a screen');
      }

      // The grid is sized from the container's *content* box, so it is fitted to
      // the box the inset has already been taken out of. Fitted against the
      // padded box it was not: 373px of screen inside a 362px `.xterm` — 14px of
      // inset on the left, 3px on the right, in every App baseline.
      //
      // The bound is **one column**, not zero, and the reason is a property of
      // the approach rather than of this fix: xterm re-measures its cell while
      // applying the resize, and draws `cols * thatCell`. When the settled cell
      // is a fraction wider than the one the fit divided by, the difference
      // compounds across the column count — measured on CI, a ~0.1px per-column
      // difference over 50 columns is ~3px of overhang, where the same build
      // locally is 2px *inside* the box. The product reads and resizes in the
      // same order (`ResizeController`), so this is not a fixture-only tolerance.
      //
      // One column still separates it from the defect: fitted against the padded
      // box the overhang was ~1.5 columns, because the inset is 28px and
      // FitAddon subtracted only its ~17px scrollbar allowance.
      const measured = await page.evaluate(() => {
        // One character's advance, as the *row's* width over its character
        // count, so nothing here depends on how xterm grouped its markup: it
        // emits one span per styled run, and the runs it finds are not stable
        // across profiles — measured on CI at `app.narrow-phone`, where the
        // App profile renders `$ git status --short` as four spans, so a
        // measurement taken from the first text node found one character where
        // it expected a word.
        //
        // Rows are used only where the text is exactly the rendered text — no
        // leading or trailing space — so the divisor is the glyph count and
        // not the cell count. A row of a monospace grid is uniform, so any
        // such row measures the advance; the longest is taken to average out
        // subpixel rounding.
        const rows = [...document.querySelectorAll('.xterm-rows > div')];
        let best: { text: string; width: number } | null = null;
        for (const row of rows) {
          const text = row.textContent ?? '';
          if (text !== text.trim() || text.length < 12) {
            continue;
          }
          const range = document.createRange();
          range.selectNodeContents(row);
          const width = range.getBoundingClientRect().width;
          if (width <= 0) {
            continue;
          }
          if (best === null || text.length > best.text.length) {
            best = { text, width };
          }
        }
        return best === null ? null : best.width / best.text.length;
      });
      if (measured === null) {
        throw new Error('no full-width rendered row to measure a column from');
      }
      // A divisor that is nonsense would make both bounds below meaningless, so
      // it is checked before it is used rather than trusted.
      expect(measured).toBeGreaterThan(2);
      expect(measured).toBeLessThan(20);
      const advance = measured;
      const boxesMessage = `xterm ${boxes.cell.left}..${boxes.cell.right}, screen ${boxes.screen.left}..${boxes.screen.right}, column ${advance}`;
      expect(boxes.screen.left, boxesMessage).toBeGreaterThanOrEqual(boxes.cell.left - advance);
      expect(boxes.screen.right, boxesMessage).toBeLessThanOrEqual(boxes.cell.right + advance);
      // …and the fit is tight: a grid that fitted by a column too few is as
      // wrong as one that fitted by a column too many.
      expect(boxes.screen.right, boxesMessage).toBeGreaterThanOrEqual(boxes.cell.right - advance);

      // Non-vacuity: a screen that "fits" by collapsing to a couple of columns
      // would satisfy the lines above, and so would a terminal whose buffer was
      // never written. Both are ruled out by the content, in the two shapes it
      // takes across the matrix: short lines stay whole on one row, long ones
      // take more rows than the buffer has lines.
      //
      // The line named is the *first* buffer line, 20 columns, because this
      // test runs at every viewport in the matrix and the longest line (52)
      // does not fit the 46 columns `app.narrow-phone` lays out. Asserting the
      // long line whole was what failed there — it holds where the grid is wide,
      // which is a different property from the one under test.
      //
      // The row count is a floor rather than an equality for the same reason:
      // the buffer has 9 non-empty lines, and wrapping only ever adds rows.
      const rows = await page.locator('.xterm-rows > div').allTextContents();
      expect(rows.some((row) => row.includes('$ git status --short'))).toBe(true);
      expect(rows.filter((row) => row.trim() !== '').length).toBeGreaterThanOrEqual(9);
    });

    test('a pushed detail keeps the capsule, and its content clears it (#1347)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      // Push a file detail: this is the App Files flow the owner measured on
      // 2026-10-03 — before the decision, opening a file took the capsule away
      // and left the editor's last line under where it had been.
      await page.getByTestId('file-row-web').click();
      await page.getByTestId('file-row-web/src').click();
      await page.getByTestId('file-row-web/src/App.tsx').click();

      const nav = page.getByTestId('workspace-capability-capsule');
      await expect(nav).toBeVisible();

      // The scroller's reachable end sits above the capsule — the same measured
      // inset the capability root spends, so *any* last line can be brought
      // clear of the bar rather than only short files passing by luck.
      const geometry = await page.evaluate(() => {
        const host = document.querySelector('[data-testid="codemirror-editor"]');
        const capsule = document.querySelector('[data-testid="workspace-capability-capsule"]');
        if (!(host instanceof HTMLElement) || !(capsule instanceof HTMLElement)) {
          return null;
        }
        const padBottom = Number.parseFloat(getComputedStyle(host).paddingBottom);
        const contentBoxBottom = host.getBoundingClientRect().bottom - padBottom;
        return { padBottom, contentBoxBottom, capsuleTop: capsule.getBoundingClientRect().top };
      });
      if (!geometry) {
        throw new Error('the pushed detail must lay out an editor and the capsule');
      }
      expect(geometry.padBottom).toBeGreaterThan(0);
      expect(geometry.contentBoxBottom).toBeLessThanOrEqual(geometry.capsuleTop + 1);
    });

    test('a pushed Workspace detail keeps its own leave (#1081)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

      await page.getByTestId('app-header-workspace').first().click();
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

      // Push a file detail. Files declares the push, so the shell's page header
      // becomes that depth's bar and Back now names the depth below it.
      await page.getByTestId('file-row-web').click();
      await page.getByTestId('file-row-web/src').click();
      await page.getByTestId('file-row-web/src/App.tsx').click();
      const back = page.getByTestId('app-page-back');
      await expect(back).toHaveAttribute('aria-label', 'Back to Files');

      const shell = await layerRoot.boundingBox();
      const editor = await page.locator('.cm-editor').boundingBox();
      if (!shell || !editor) {
        throw new Error('the pushed detail must lay out a shell and an editor');
      }
      const y = Math.round(editor.y + editor.height / 2);

      // From inside the editor's own left edge — CodeMirror's line-number
      // gutter sits at x = 0, so this is the touch the edge band re-admitted,
      // and before this rule it left the whole depth and discarded whatever
      // `Back to Files` was guarding.
      await swipeHorizontally(page, { y, fromX: shell.x + 10, toX: shell.x + 170 });
      await page.waitForTimeout(300);
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');
      await expect(back).toHaveAttribute('aria-label', 'Back to Files');

      // …and the depth's own leave walks the directory stack (#1140) before the
      // capability root, where Back and the shell both mean the Terminal.
      await back.click();
      await expect(page.getByTestId('app-page-header')).toContainText('src');
      await expect(back).toHaveAttribute('aria-label', 'Back to Files');
      await back.click();
      await expect(page.getByTestId('app-page-header')).toContainText('web');
      await back.click();
      await expect(page.getByTestId('app-page-header')).toContainText('Files');
      await expect(back).toHaveAttribute('aria-label', 'Back to terminal');

      // The pair: at the capability root the shell's gesture is back, because
      // there Back and the shell both mean the Terminal.
      await swipeHorizontally(page, { y, fromX: shell.x + 10, toX: shell.x + 170 });
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
    });

    test('the no-Session root is a home with an action, not a status line (#1082)', async ({ page }) => {
      await page.goto('/#/fixture/app?selection=none');

      await expect(page.getByTestId('app-home')).toBeVisible();
      // The screen it replaced: a status report with nothing to act on, and no
      // route back to the Sessions list once the drawer was dismissed.
      await expect(page.getByTestId('session-empty-state')).toHaveCount(0);

      const create = page.getByTestId('app-home-new-session');
      await expect(create).toBeEnabled();
      await expect(create).toBeVisible();

      // Both ways out are visible controls — a gesture is an accelerator, and
      // on this screen the only layer to reach is Sessions.
      await expect(page.getByTestId('app-home-browse-sessions')).toBeVisible();
      const sessions = page.getByTestId('app-header-sessions');
      await expect(sessions).toBeVisible();
      // Same affordance, same band, same control as on a selected Session, so
      // it is held to the chrome pattern's App touch floor rather than to a
      // number written here.
      await expectTouchTarget(sessions, optsFor(PATTERN_SESSION_HEADER, 'app', row.id));

      // Workspace is the depth *around* work. With none, it is not offered —
      // and the layer it would open does not exist either.
      await expect(page.getByTestId('app-header-workspace')).toHaveCount(0);
      await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);
    });

    test('the no-Session root pages to Sessions and to nothing else (#1082)', async ({ page }) => {
      await page.goto('/#/fixture/app?selection=none');
      await expect(page.getByTestId('app-home')).toBeVisible();

      const shell = await page.getByTestId('app-layer-root').boundingBox();
      if (!shell) {
        throw new Error('the App shell must be laid out');
      }
      const y = shell.y + shell.height / 2;

      // Leftward from the right edge band. There is no third position to page
      // to, so this must be a no-op rather than a slide onto a blank depth.
      await swipeHorizontally(page, {
        y,
        fromX: shell.x + shell.width - 2,
        toX: shell.x + shell.width - 150,
      });
      // A no-op is an absence, so it needs a window in which a wrong commit
      // could land before the positive case below makes the silence evidence.
      await page.waitForTimeout(300);
      await expect(page.getByTestId('app-layer-root')).toHaveAttribute('data-layer', 'terminal');
      await expect(page.getByTestId('app-layer-workspace')).toHaveCount(0);

      // Rightward from the left edge band: the one layer that does exist.
      await swipeHorizontally(page, { y, fromX: shell.x + 2, toX: shell.x + 150 });
      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
    });

    test('the top-level swipe reaches the work surface from the shell edge (#1081)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

      const shell = await layerRoot.boundingBox();
      const surface = await page.locator('.xterm').first().boundingBox();
      if (!shell || !surface) {
        throw new Error('the App shell and its terminal surface must both be laid out');
      }
      const y = shell.y + shell.height / 2;

      // The probe is 4px inside the *surface's own* left edge rather than a
      // fixed 4px from the shell: what has to hold is that the band reaches
      // past the terminal's padding gutter and onto the surface, and the
      // gutter is `--terminal-pad-x`. Narrow the band below `surface.x + 4`
      // and this fails — which is right, because the band would then add
      // nothing the gate did not already allow.
      await swipeHorizontally(page, { y, fromX: surface.x + 4, toX: surface.x + 144 });

      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
    });

    test('the work surface keeps a drag that starts inside it (#1081)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');

      const shell = await layerRoot.boundingBox();
      const surface = await page.locator('.xterm').first().boundingBox();
      if (!shell || !surface) {
        throw new Error('the App shell and its terminal surface must both be laid out');
      }
      const y = shell.y + shell.height / 2;

      // The middle of the surface is nobody's edge. Nothing may be claimed
      // there — that is the half of #1049 that #1081 did not touch.
      const middle = Math.round(surface.x + surface.width / 2);
      await swipeHorizontally(page, { y, fromX: middle, toX: middle + 140 });

      // Absence, so it needs a window in which a wrong commit could land: the
      // shell's own state updates land a tick late (React commits out of band),
      // and a bare `toHaveCount(0)` would pass before the gesture had been
      // processed at all.
      await page.waitForTimeout(300);
      await expect(page.getByTestId('app-layer-sessions')).toHaveCount(0);

      // …and the same swipe from the shell edge then opens it, which is what
      // makes the silence above evidence rather than timing. Without this, a
      // build where the pager was simply never wired up would pass.
      const shellEdge = Math.round(surface.x + 4);
      await swipeHorizontally(page, { y, fromX: shellEdge, toX: shellEdge + 140 });
      await expect(page.getByTestId('app-layer-sessions')).toBeVisible();
    });

    test('the capability capsule owns its drag: panning the row never pages (#1347)', async ({ page }) => {
      await page.goto('/#/fixture/app');
      await page.getByTestId('app-header-workspace').first().click();
      await expect(page.getByTestId('files-app-layout')).toBeVisible();

      const layerRoot = page.getByTestId('app-layer-root');
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

      // Whether the row overflows is a property of the viewport, not of this
      // rule: at `app.landscape-phone` (844 wide) six slots fit and there is
      // nothing to pan, while the drag below must still be the row's — the
      // entries are controls, not a page-start. So the row's own scroll extent
      // is not asserted; the observable here is the layer.
      const row = page.getByTestId('workspace-capability-scroll');
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      if (!box) {
        throw new Error('the capability row must be laid out');
      }
      const y = Math.round(box.y + box.height / 2);

      // A rightward drag from the middle of the row is the gesture the owner
      // measured on 2026-10-03: the row panned *and* the shell paged back to
      // the Terminal. The row is a work surface now (#1049's exclusion,
      // extended), so the shell must not follow the finger…
      const middle = Math.round(box.x + box.width / 2);
      await swipeHorizontally(page, { y, fromX: middle, toX: middle + 140 });
      await page.waitForTimeout(300);
      await expect(layerRoot).toHaveAttribute('data-layer', 'workspace');

      // …and the shell still pages from a start that IS navigation — its own
      // header band, whose left edge is chrome at every App viewport (the
      // capsule's own left edge is only inside the 28px band in portrait, and
      // the file list swallows the drag in landscape, so neither is a stable
      // anchor here). Without this half, a pager that had simply stopped
      // working would pass the assertion above. The narrower case — the edge
      // band over a work surface — is `#1081`'s test, measured on the xterm.
      const shell = await layerRoot.boundingBox();
      const header = await page.getByTestId('app-header-sessions').boundingBox();
      if (!shell || !header) {
        throw new Error('the App shell and its header must be laid out');
      }
      await swipeHorizontally(page, {
        y: Math.round(header.y + header.height / 2),
        fromX: Math.round(shell.x + 6),
        toX: Math.round(shell.x + 156),
      });
      await expect(layerRoot).toHaveAttribute('data-layer', 'terminal');
    });
  });
}
