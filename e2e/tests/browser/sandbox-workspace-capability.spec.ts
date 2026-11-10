// e2e/tests/browser/sandbox-workspace-capability.spec.ts
import { expect, test, type Page } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

/**
 * Issues #3124 and #3143: the Sandbox capability is a Session-context surface
 * with six peer policy tabs.
 *
 * The fixture routes name what the Agent answered (`?sandbox=…`), never a
 * rendering. These assertions cover the explicit outside draft, the empty-first
 * native editors, per-implementation support, preflight invalidation, the one
 * confirmation, the inside effective projection, and the truthful no-Enter
 * states — on Web and App at the Issues' viewport pairs.
 */

async function openWebSandbox(page: Page, query = ''): Promise<void> {
  await page.goto(`/#/fixture/workspace?capability=sandbox${query}`);
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
}

async function openAppSandbox(page: Page, query = ''): Promise<void> {
  // The scenario is a route input read at load: navigate with it first. A
  // second hash-only `goto` does not reload the app, and the already-mounted
  // capability would keep its previous Agent answer.
  await page.goto(`/#/fixture/app${query}`);
  await page.getByTestId('app-header-workspace').click();
  await page.getByTestId('workspace-tool-sandbox').click();
  await expect(page.getByTestId('sandbox-workspace')).toBeVisible();
}

async function selectTab(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`sandbox-tab-${tab}`).click();
  await expect(page.getByTestId(`sandbox-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
}

test.describe('Web 1180', () => {
  test.use({ viewport: { width: 1180, height: 900 } });

  test('six peer tabs switch directly without history depth (#3143 SC-01, SC-07)', async ({
    page,
  }) => {
    await openWebSandbox(page);
    const historyLength = await page.evaluate(() => window.history.length);

    await expect(page.getByTestId('sandbox-tabs')).toBeVisible();
    for (const tab of ['overview', 'filesystem', 'network', 'process', 'resource', 'syscall']) {
      await expect(page.getByTestId(`sandbox-tab-${tab}`)).toBeVisible();
    }
    // Only the selected peer panel is materialized; there is no Home page or
    // five-forms-at-once layout.
    await expect(page.getByTestId('sandbox-policy-preview')).toBeVisible();
    await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-syscall-profile')).toHaveCount(0);

    const content: Record<string, string> = {
      overview: 'sandbox-policy-preview',
      filesystem: 'sandbox-fs-read',
      network: 'sandbox-network-mode',
      process: 'sandbox-namespace-pid',
      resource: 'sandbox-resource-add',
      syscall: 'sandbox-syscall-profile',
    };
    for (const tab of Object.keys(content)) {
      await selectTab(page, tab);
      await expect(page.getByTestId(content[tab])).toBeVisible();
    }

    // The Overview summary is a second direct switch, not a drill-down.
    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-summary-network').click();
    await expect(page.getByTestId('sandbox-tab-network')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sandbox-network-mode')).toBeVisible();

    // Keyboard tab semantics: arrows move within the vertical list, Home/End
    // jump to its ends, and selection never creates history.
    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-tab-overview').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('sandbox-tab-filesystem')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('End');
    await expect(page.getByTestId('sandbox-tab-syscall')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('sandbox-tab-overview')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  });

  test('sticky left navigation and one wide scrolling editor at 1180 (#3143 SC-02)', async ({
    page,
  }) => {
    await openWebSandbox(page);
    await selectTab(page, 'resource');
    for (let index = 0; index < 8; index += 1) {
      await page.getByTestId('sandbox-resource-add').click();
    }
    await expect(page.getByTestId('sandbox-resource-row-7')).toBeVisible();

    const content = page.getByTestId('sandbox-tab-content');
    const scrollable = await content.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    );
    expect(scrollable).toBe(true);

    const tabsBefore = await page.getByTestId('sandbox-tabs').boundingBox();
    const contentBox = await content.boundingBox();
    expect(tabsBefore).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(tabsBefore!.x + tabsBefore!.width).toBeLessThanOrEqual(contentBox!.x + 1);
    expect(contentBox!.x + contentBox!.width).toBeLessThanOrEqual(1180);

    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const tabsAfter = await page.getByTestId('sandbox-tabs').boundingBox();
    expect(tabsAfter).not.toBeNull();
    expect(Math.abs(tabsAfter!.y - tabsBefore!.y)).toBeLessThan(1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const paddingBottom = await content.evaluate(
      (element) => getComputedStyle(element).paddingBottom,
    );
    expect(parseFloat(paddingBottom)).toBeGreaterThan(0);
  });

  test('draft and fresh preflight survive tab switches; edits invalidate (#3143 SC-05)', async ({
    page,
  }) => {
    await openWebSandbox(page);
    await selectTab(page, 'resource');
    await page.getByTestId('sandbox-resource-add').click();
    await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
    await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');

    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await expect(page.getByTestId('sandbox-enter')).toBeEnabled();
    await expect(page.getByTestId('sandbox-policy-preview')).toContainText('cpu.max');

    // Merely switching peer tabs preserves the draft and the validation.
    await selectTab(page, 'filesystem');
    await selectTab(page, 'syscall');
    await selectTab(page, 'overview');
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await expect(page.getByTestId('sandbox-enter')).toBeEnabled();

    // An actual edit invalidates it.
    await selectTab(page, 'resource');
    await page.getByTestId('sandbox-resource-value-0').fill('200000 1000000');
    await selectTab(page, 'overview');
    await expect(page.getByTestId('sandbox-preflight-ok')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

    // Confirm and Enter use the exact assembled payload.
    await selectTab(page, 'resource');
    await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-enter')).toBeEnabled();
    await page.getByTestId('sandbox-enter').click();
    await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
    await page.getByTestId('sandbox-confirm-enter').click();
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    await selectTab(page, 'resource');
    await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toContainText(
      '200000 100000',
    );
    await selectTab(page, 'overview');
    await expect(page.getByTestId('sandbox-scope-note')).toContainText(
      'future Panes or Windows are not inside this Sandbox',
    );
  });

  test('every registered implementation reports its measured status in its tab (#3161 SC-04)', async ({
    page,
  }) => {
    await openWebSandbox(page);

    await selectTab(page, 'filesystem');
    await expect(page.getByTestId('sandbox-implementation-status-filesystem.access')).toHaveText(
      'available',
    );
    await expect(
      page.getByTestId('sandbox-implementation-status-filesystem.composition'),
    ).toHaveText('available');
    await expect(page.getByTestId('sandbox-fs-read')).toBeEnabled();

    await selectTab(page, 'network');
    await expect(page.getByTestId('sandbox-implementation-status-network')).toHaveText(
      'available',
    );
    await expect(page.getByTestId('sandbox-network-mode')).toBeEnabled();

    await selectTab(page, 'process');
    await expect(
      page.getByTestId('sandbox-implementation-status-process.linux_namespaces'),
    ).toHaveText('available');
    await expect(page.getByTestId('sandbox-namespace-pid')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await selectTab(page, 'resource');
    await expect(page.getByTestId('sandbox-implementation-status-resource.cgroup_v2')).toHaveText(
      'available',
    );
    await expect(page.getByTestId('sandbox-resource-add')).toBeEnabled();

    await selectTab(page, 'syscall');
    await expect(page.getByTestId('sandbox-implementation-status-syscall.seccomp')).toHaveText(
      'available',
    );
    await expect(page.getByTestId('sandbox-syscall-profile')).toBeEnabled();
  });

  test('macOS disables Linux-native implementations per tab (#3161 SC-04)', async ({ page }) => {
    await openWebSandbox(page, '&sandbox=macos');

    await selectTab(page, 'filesystem');
    await expect(page.getByTestId('sandbox-implementation-status-filesystem.access')).toHaveText(
      'unavailable',
    );
    await expect(page.getByTestId('sandbox-fs-read')).toBeDisabled();
    await expect(page.getByTestId('sandbox-fs-write')).toBeDisabled();

    await selectTab(page, 'network');
    await expect(page.getByTestId('sandbox-implementation-status-network')).toHaveText(
      'available',
    );
    await page.getByTestId('sandbox-network-mode').click();
    await expect(page.getByTestId('sandbox-network-mode-deny')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByTestId('sandbox-network-mode-restricted')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');

    await selectTab(page, 'process');
    await expect(
      page.getByTestId('sandbox-implementation-status-process.linux_namespaces'),
    ).toHaveText('unavailable');
    await expect(page.getByTestId('sandbox-namespace-pid')).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await selectTab(page, 'resource');
    await expect(page.getByTestId('sandbox-implementation-status-resource.cgroup_v2')).toHaveText(
      'unavailable',
    );
    await expect(page.getByTestId('sandbox-resource-add')).toBeDisabled();

    await selectTab(page, 'syscall');
    await expect(page.getByTestId('sandbox-implementation-status-syscall.seccomp')).toHaveText(
      'unavailable',
    );
    await expect(page.getByTestId('sandbox-syscall-profile')).toBeDisabled();
  });

  test('a measured missing CPU delegation disables the field and blocks the draft (#3124 SC-02)', async ({
    page,
  }) => {
    await openWebSandbox(page, '&sandbox=limited');
    await selectTab(page, 'resource');

    await expect(page.getByTestId('sandbox-implementation-status-resource.cgroup_v2')).toHaveText(
      'available',
    );
    const cpuOption = page.locator('#sandbox-resource-key-options option[value="cpu.max"]');
    await expect(cpuOption).toHaveCount(1);
    await expect(cpuOption).toContainText('unavailable');

    await page.getByTestId('sandbox-resource-add').click();
    await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
    await expect(page.getByTestId('sandbox-resource-value-0')).toBeDisabled();
    await expect(page.getByTestId('sandbox-resource-value-unavailable-0')).toContainText(
      'not delegated',
    );
    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-errors')).toContainText('not installable');
    await expect(page.getByTestId('sandbox-enter')).toBeDisabled();
  });

  test('inside keeps the same read-only tabs and the EROFS evidence (#3143 SC-04, SC-06)', async ({
    page,
  }) => {
    await openWebSandbox(page, '&sandbox=inside-erofs');
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    await expect(page.getByTestId('sandbox-scope-note')).toContainText(
      'future Panes or Windows are not inside this Sandbox',
    );
    await expect(page.getByTestId('sandbox-tabs')).toBeVisible();

    await selectTab(page, 'filesystem');
    await expect(page.getByTestId('sandbox-effective-erofs')).toBeVisible();
    await expect(page.getByTestId('sandbox-fs-read')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-fs-write')).toHaveCount(0);

    await selectTab(page, 'network');
    await expect(page.getByTestId('sandbox-effective-network-mode')).toHaveText('deny');

    await selectTab(page, 'process');
    await expect(page.getByTestId('sandbox-effective-namespaces')).toContainText('pid');

    await selectTab(page, 'resource');
    await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toBeVisible();
    await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);

    await selectTab(page, 'syscall');
    await expect(page.getByTestId('sandbox-effective-syscall-seccomp.profile')).toBeVisible();
    await expect(page.getByTestId('sandbox-syscall-profile')).toHaveCount(0);
  });

  test('unknown/unsupported/offline never claim protection or offer Enter (#3124 SC-05)', async ({
    page,
  }) => {
    await openWebSandbox(page, '&sandbox=unknown');
    await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
    await expect(page.getByTestId('sandbox-status')).toHaveText('unknown');
    await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-tabs')).toHaveCount(0);

    await openWebSandbox(page, '&sandbox=unsupported');
    await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
    await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);

    await openWebSandbox(page, '&sandbox=offline');
    await expect(page.getByTestId('sandbox-context-error')).toBeVisible();
    await expect(page.getByTestId('sandbox-retry')).toBeVisible();
    await expect(page.getByTestId('sandbox-inside')).toHaveCount(0);
  });

  test('return to Native keeps the sandbox pane reachable (#3124 SC-04)', async ({ page }) => {
    await openWebSandbox(page, '&sandbox=inside');
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    await page.getByTestId('sandbox-return-native').click();
    await expect(page.getByTestId('sandbox-composer')).toBeVisible();
    await expect(page.getByTestId('sandbox-existing-panes')).toBeVisible();
    await page.getByTestId('sandbox-focus-existing-%2').click();
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
  });
});

test.describe('Web 1024', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('tabs and the scrolling editor stay inside the pane (#3143 SC-02)', async ({ page }) => {
    await openWebSandbox(page);
    await selectTab(page, 'resource');
    await page.getByTestId('sandbox-resource-add').click();
    await expect(page.getByTestId('sandbox-resource-row-0')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const input = await page.getByTestId('sandbox-resource-key-0').boundingBox();
    expect(input).not.toBeNull();
    expect(input!.x + input!.width).toBeLessThanOrEqual(1024);

    const tabs = await page.getByTestId('sandbox-tabs').boundingBox();
    const content = await page.getByTestId('sandbox-tab-content').boundingBox();
    expect(tabs).not.toBeNull();
    expect(content).not.toBeNull();
    expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(content!.x + 1);
  });
});

test.describe('App 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('horizontal peer tabs, one host Back and no depth per switch (#3143 SC-03)', async ({
    page,
  }) => {
    await openAppSandbox(page);
    const historyLength = await page.evaluate(() => window.history.length);
    await expect(page.getByTestId('app-page-back')).toHaveCount(1);
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');

    const tablist = page.getByTestId('sandbox-tabs');
    await expect(tablist).toHaveAttribute('data-orientation', 'horizontal');
    const overview = await page.getByTestId('sandbox-tab-overview').boundingBox();
    expect(overview).not.toBeNull();
    expect(overview!.height).toBeGreaterThanOrEqual(44);

    const content: Record<string, string> = {
      overview: 'sandbox-policy-preview',
      filesystem: 'sandbox-fs-read',
      network: 'sandbox-network-mode',
      process: 'sandbox-namespace-pid',
      resource: 'sandbox-resource-add',
      syscall: 'sandbox-syscall-profile',
    };
    for (const tab of Object.keys(content)) {
      await selectTab(page, tab);
      await expect(page.getByTestId(content[tab])).toBeVisible();
      await expect(page.getByTestId('app-page-back')).toHaveCount(1);
      await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to terminal');
    }

    // Keyboard arrows move along the horizontal strip.
    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-tab-overview').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('sandbox-tab-filesystem')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

    // Confirmation is the only pushed depth; its Back restores the tab.
    await selectTab(page, 'overview');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await page.getByTestId('sandbox-enter').click();
    await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('Enter Sandbox');
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Sandbox');
    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('sandbox-composer')).toBeVisible();
    await expect(page.getByTestId('sandbox-tab-overview')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('the tab strip stays above the single vertical scroller (#3143 SC-03)', async ({ page }) => {
    await openAppSandbox(page);
    await selectTab(page, 'resource');
    for (let index = 0; index < 8; index += 1) {
      await page.getByTestId('sandbox-resource-add').click();
    }
    await expect(page.getByTestId('sandbox-resource-row-7')).toBeVisible();

    const scroller = page.getByTestId('sandbox-app-scroll');
    await scroller.evaluate((element) => {
      element.scrollTop = 400;
    });
    const scatterBox = await scroller.boundingBox();
    const tabsBox = await page.getByTestId('sandbox-tabs').boundingBox();
    expect(scatterBox).not.toBeNull();
    expect(tabsBox).not.toBeNull();
    expect(tabsBox!.y).toBeGreaterThanOrEqual(scatterBox!.y - 1);
    expect(tabsBox!.y - scatterBox!.y).toBeLessThan(16);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('sandbox-app-scroll')).toBeVisible();
  });

  test('KV rows fit the phone pane (#3143 SC-03, #3124 SC-06)', async ({ page }) => {
    await openAppSandbox(page);
    await selectTab(page, 'resource');
    await page.getByTestId('sandbox-resource-add').click();
    await expect(page.getByTestId('sandbox-resource-row-0')).toBeVisible();
    const keyBox = await page.getByTestId('sandbox-resource-key-0').boundingBox();
    expect(keyBox).not.toBeNull();
    expect(keyBox!.x).toBeGreaterThanOrEqual(0);
    expect(keyBox!.x + keyBox!.width).toBeLessThanOrEqual(390);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('sandbox-app-scroll')).toBeVisible();
  });
});

test.describe('App 375', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('inside tabs stay read-only without horizontal overflow (#3143 SC-06)', async ({
    page,
  }) => {
    await openAppSandbox(page, '?sandbox=inside');
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    await selectTab(page, 'resource');
    await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toBeVisible();
    await expect(page.getByTestId('sandbox-resource-add')).toHaveCount(0);
    await selectTab(page, 'syscall');
    await expect(page.getByTestId('sandbox-effective-syscall-seccomp.profile')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('sandbox-scope-note')).toBeVisible();
  });
});
