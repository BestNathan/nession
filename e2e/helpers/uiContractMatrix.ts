// Shared Web/App viewport assertions for independently runnable matrix specs
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
} from './ui-assert/assertions';
import { loadContracts, patternBlock, type Experience } from './ui-assert/contracts';
import { swipeHorizontally } from './shell';
import { waitForFixtureTerminal } from './fixtureVisual';



export const { viewports } = loadContracts();

export const PATTERN_SESSION_HEADER = 'pattern.session-header';
export const PATTERN_SESSION_ITEM = 'pattern.session-item';
export const PATTERN_WORKSPACE_NAV = 'pattern.workspace-navigation';
export const PATTERN_TERMINAL_CAPSULE = 'pattern.terminal-capsule';
export const PATTERN_POPUP_MENU = 'pattern.popup-menu';
export const PATTERN_CONTEXT_CAPSULE = 'pattern.context-capsule';

export function optsFor(pattern: string, experience: Experience, viewport: string) {
  return { pattern, experience, viewport } as const;
}

export async function assertSessionRowsClipped(page: Parameters<typeof test>[0]['page'], experience: Experience, viewportId: string) {
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
export async function assertPopupMenu(
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

export async function upperCapsuleVisualSignature(
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
export async function assertContextCapsule(
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
export async function contextCapsuleBoxInState(
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
export async function assertSameHeightAcrossSenseStates(
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
export async function assertRowOpensDetail(
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

export async function assertWorkspaceEntryStateKeepsVisualGrammar(
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


export async function capsuleOuterBox(
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

export async function captureProductionWorkspaceCapabilityRow(
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

export async function assertProductionCapabilityCountOnlyChangesScrollExtent(
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

export async function assertCapabilityRowCssStress(
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

export async function assertWebCapsuleOuterGeometry(
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

export async function assertDestinationSharesCapsuleMaterial(
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

export async function assertWorkRingPerceptible(
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

// ── Terminal capsule — the Session's primary input surface ─────────────────

/**
 * `pattern.terminal-capsule` was the one pattern with no matrix row. It appeared
 * exactly once under `e2e/`, in a self-test of the assertion helper that runs
 * against synthetic DOM, so its contract — including the `overflow` strategy —
 * had never been checked against a real screen. Adding the capsule to the
 * fixture is what made these assertions possible.
 */
export async function assertCapsuleControls(
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
