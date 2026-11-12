import type { Locator, Page } from '@playwright/test';
import { UiContractViolation, type AssertOptions } from './assertions';

/**
 * Layout-ownership browser assertions (#3194).
 *
 * The design Gate owns the static ownership rules. These helpers measure the
 * consequence on the real production fixture: which element actually scrolls,
 * whether the master/detail host clips, whether a form's labels and controls
 * start at one edge, and whether the App has one page header/Back.
 *
 * They deliberately measure the *rendered* relation. A view can name the right
 * class and still put its scroll on a different ancestor; only the computed DOM
 * says which one the user's wheel/finger reaches.
 */

function violation(
  opts: AssertOptions,
  rule: string,
  expected: string,
  actual: string,
  measured?: string,
): never {
  throw new UiContractViolation({
    pattern: opts.pattern,
    rule,
    experience: opts.experience,
    viewport: opts.viewport,
    expected,
    actual,
    measured,
  });
}

interface ScrollOwner {
  testId: string | null;
  marked: boolean;
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Exactly one rendered element inside `root` actually scrolls vertically.
 *
 * `recipe` requires that element to publish the shared
 * `data-workspace-scroll-owner` marker. Set it to false for a surface whose
 * local scroll is genuinely inner (the Sandbox tab panel on Web), but never
 * for an experience-composed Workspace detail.
 */
export async function expectSingleWorkspaceScrollOwner(
  root: Locator,
  opts: AssertOptions & { recipe?: boolean },
): Promise<void> {
  const owners: ScrollOwner[] = await root.evaluate((el) => {
    const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
    return nodes
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          testId: node.getAttribute('data-testid'),
          marked: node.getAttribute('data-workspace-scroll-owner') === 'true',
          overflowY: style.overflowY,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none',
        };
      })
      .filter(
        (node) =>
          node.visible &&
          ['auto', 'scroll', 'overlay'].includes(node.overflowY) &&
          node.scrollHeight > node.clientHeight + 1,
      );
  });

  if (owners.length !== 1) {
    violation(
      opts,
      'single-scroll-owner',
      'exactly one rendered vertical scroll owner',
      `${owners.length} owners`,
      owners.map((owner) => owner.testId ?? owner.overflowY).join(', '),
    );
  }
  if ((opts.recipe ?? true) && !owners[0].marked) {
    violation(
      opts,
      'single-scroll-owner',
      'the single scroll owner is the shared WorkspaceScrollRegion',
      `the owner is ${owners[0].testId ?? '(no testid)'} without the recipe marker`,
    );
  }
}

/** The master/detail host clips, fills its parent, and exposes both regions. */
export async function expectWorkspaceMasterDetail(
  host: Locator,
  opts: AssertOptions,
): Promise<void> {
  const layout = host.locator('[data-workspace-layout="master-detail"]');
  if ((await layout.count()) !== 1) {
    violation(
      opts,
      'master-detail-host',
      'one shared WorkspaceMasterDetail host',
      `${await layout.count()} found`,
    );
  }
  const geometry = await layout.evaluate((el) => {
    const style = getComputedStyle(el);
    const parent = el.parentElement;
    return {
      overflowY: style.overflowY,
      overflowX: style.overflowX,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      height: el.getBoundingClientRect().height,
      parentHeight: parent?.getBoundingClientRect().height ?? 0,
      navigation: el.querySelectorAll('[data-workspace-layout-part="navigation"]').length,
      content: el.querySelectorAll('[data-workspace-layout-part="content"]').length,
    };
  });
  if (geometry.overflowY !== 'hidden') {
    violation(opts, 'master-detail-host', 'the host clips, panes own their scroll', geometry.overflowY);
  }
  if (geometry.navigation !== 1 || geometry.content !== 1) {
    violation(
      opts,
      'master-detail-host',
      'one navigation and one content region',
      `${geometry.navigation} navigation / ${geometry.content} content`,
    );
  }
  if (geometry.scrollWidth > geometry.clientWidth + 1) {
    violation(
      opts,
      'master-detail-host',
      'the host does not overflow horizontally',
      `${geometry.scrollWidth - geometry.clientWidth}px`,
    );
  }
  if (Math.abs(geometry.height - geometry.parentHeight) > 1) {
    violation(
      opts,
      'master-detail-host',
      'the host fills its parent height',
      `${geometry.height.toFixed(1)}px in ${geometry.parentHeight.toFixed(1)}px`,
    );
  }
}

/** The App renders exactly one page header and never more than one Back. */
export async function expectSingleAppHeader(page: Page, opts: AssertOptions): Promise<void> {
  const headers = await page.locator('[data-testid="app-page-header"]').count();
  if (headers !== 1) {
    violation(opts, 'single-app-header', 'exactly one App page header', `${headers} found`);
  }
  const backs = await page.locator('[data-testid="app-page-back"]').count();
  if (backs > 1) {
    violation(opts, 'single-app-header', 'at most one App Back for the depth', `${backs} found`);
  }
}

/**
 * Deterministically grow a repeatable form until the retained surface actually
 * overflows.
 *
 * The scroll-owner relation only exists when content exceeds the pane. Fixed
 * row counts make the test viewport-dependent (16 rows overflow 1024×768 but
 * not 1920×1080); this stops as soon as a real scroller appears and lets the
 * assertion report the failure if the limit is reached without one.
 */
export async function growUntilWorkspaceScrolls(
  page: Page,
  addTestId: string,
  rootTestId = 'workspace-tool-content',
  limit = 40,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const overflowing = await page.getByTestId(rootTestId).evaluate((el) => {
      const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
      return nodes.some(
        (node) =>
          node instanceof HTMLElement &&
          ['auto', 'scroll', 'overlay'].includes(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight + 1,
      );
    });
    if (overflowing) return;
    await page.getByTestId(addTestId).click();
  }
}

/**
 * A form's label and its control share one left edge. This is the measurable
 * "same-row form label/field start" relation, independent of how many columns
 * the composition uses.
 */
export async function expectFormFieldAlignment(
  form: Locator,
  opts: AssertOptions,
): Promise<void> {
  const misaligned = await form.evaluate((el) => {
    const fields = Array.from(el.querySelectorAll('[data-recipe-part="form-field"]'));
    const offenders = [];
    for (const field of fields) {
      const label = field.querySelector('[data-recipe-part="form-label"]');
      const control = field.querySelector('input, textarea, select, button');
      if (!(label instanceof HTMLElement) || !(control instanceof HTMLElement)) continue;
      const labelRect = label.getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      if (labelRect.width === 0 || controlRect.width === 0) continue;
      if (Math.abs(labelRect.left - controlRect.left) > 1) {
        offenders.push({
          label: label.textContent?.trim().slice(0, 24) ?? '',
          delta: Math.round(controlRect.left - labelRect.left),
        });
      }
    }
    return offenders;
  });
  if (misaligned.length > 0) {
    violation(
      opts,
      'form-field-alignment',
      'each field label and control start at one left edge',
      `${misaligned.length} misaligned`,
      misaligned.map((item) => `${item.label} ${item.delta}px`).join(', '),
    );
  }
}
