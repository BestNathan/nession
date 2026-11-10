// e2e/tests/browser/sandbox-workspace-capability.spec.ts
import { expect, test, type Page } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

/**
 * Issue #3124: the Sandbox capability is a Session-context surface.
 *
 * The fixture routes name what the Agent answered (`?sandbox=…`), never a
 * rendering. These assertions cover the explicit outside draft, the empty-first
 * Resource/Syscall editor, preflight invalidation, the one confirmation, the
 * inside effective projection, and the truthful no-Enter states — on Web and
 * App at the Issue's viewport pairs.
 */

async function openWebSandbox(page: Page, query: string): Promise<void> {
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

test.describe('Web 1180', () => {
  test.use({ viewport: { width: 1180, height: 900 } });

  test('empty-first Resource/Syscall editor, preflight invalidation and Enter (#3124 SC-05)', async ({
    page,
  }) => {
    await openWebSandbox(page, '');

    await expect(page.getByTestId('sandbox-status')).toHaveText('outside');
    await expect(page.getByTestId('sandbox-resource-empty')).toBeVisible();
    await expect(page.getByTestId('sandbox-syscall-empty')).toBeVisible();
    await expect(page.getByTestId('sandbox-resource-key-0')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

    // Add a row: it starts blank, so it cannot pass preflight.
    await page.getByTestId('sandbox-resource-add').click();
    await expect(page.getByTestId('sandbox-resource-row-0')).toBeVisible();
    await page.getByTestId('sandbox-resource-key-0').fill('memory.swap.max');
    await page.getByTestId('sandbox-resource-value-0').fill('1');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('not a V1 cgroup');
    await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

    // The native cpu.max format is enforced, including the period range.
    await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
    await page.getByTestId('sandbox-resource-value-0').fill('200000 999');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-error-0')).toContainText('not a valid native value');

    await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await expect(page.getByTestId('sandbox-enter')).toBeEnabled();

    // Any edit invalidates the preflight.
    await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
    await page.getByTestId('sandbox-resource-value-0').press('End');
    await page.getByTestId('sandbox-resource-value-0').type('0');
    await expect(page.getByTestId('sandbox-preflight-ok')).toHaveCount(0);
    await expect(page.getByTestId('sandbox-enter')).toBeDisabled();

    // Re-validate, confirm, and observe the Agent's effective policy.
    await page.getByTestId('sandbox-resource-value-0').fill('200000 100000');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-enter')).toBeEnabled();
    await page.getByTestId('sandbox-enter').click();
    await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
    await page.getByTestId('sandbox-confirm-enter').click();
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    await expect(page.getByTestId('sandbox-status')).toHaveText('inside');
    await expect(page.getByTestId('sandbox-effective-resource-cpu.max')).toContainText(
      '200000 100000',
    );
    await expect(page.getByTestId('sandbox-scope-note')).toContainText(
      'future Panes or Windows are not inside this Sandbox',
    );
  });

  test('a measured missing CPU delegation disables the field and blocks the draft (#3124 SC-02, #3161 SC-04)', async ({
    page,
  }) => {
    await openWebSandbox(page, '&sandbox=limited');

    // The implementation itself remains available: memory/pids are usable.
    await expect(page.getByTestId('sandbox-implementation-status-resource.cgroup_v2')).toHaveText(
      'available',
    );
    const cpuOption = page.locator('#sandbox-resource-key-options option[value="cpu.max"]');
    await expect(cpuOption).toHaveCount(1);
    await expect(cpuOption).toContainText('unavailable');

    await page.getByTestId('sandbox-resource-add').click();
    await page.getByTestId('sandbox-resource-key-0').fill('cpu.max');
    // A measured-unavailable native field cannot be given a value in the UI.
    await expect(page.getByTestId('sandbox-resource-value-0')).toBeDisabled();
    await expect(page.getByTestId('sandbox-resource-value-unavailable-0')).toContainText(
      'not delegated',
    );
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-errors')).toContainText('not installable');
    await expect(page.getByTestId('sandbox-enter')).toBeDisabled();
  });

  test('every registered implementation reports its measured status (#3161 SC-04)', async ({
    page,
  }) => {
    await openWebSandbox(page, '');
    for (const path of [
      'filesystem.access',
      'filesystem.composition',
      'network',
      'process.linux_namespaces',
      'resource.cgroup_v2',
      'syscall.seccomp',
    ]) {
      await expect(page.getByTestId(`sandbox-implementation-status-${path}`)).toHaveText(
        'available',
      );
    }
    await expect(page.getByTestId('sandbox-fs-read')).toBeEnabled();
    await expect(page.getByTestId('sandbox-network-mode')).toBeEnabled();
    await expect(page.getByTestId('sandbox-namespace-pid')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByTestId('sandbox-resource-add')).toBeEnabled();
    await expect(page.getByTestId('sandbox-syscall-add')).toBeEnabled();
  });

  test('macOS disables Linux-native implementations and only unsupported network modes (#3161 SC-04)', async ({
    page,
  }) => {
    await openWebSandbox(page, '&sandbox=macos');

    await expect(page.getByTestId('sandbox-implementation-status-filesystem.access')).toHaveText(
      'unavailable',
    );
    await expect(page.getByTestId('sandbox-implementation-status-network')).toHaveText(
      'available',
    );
    for (const path of ['process.linux_namespaces', 'resource.cgroup_v2', 'syscall.seccomp']) {
      await expect(page.getByTestId(`sandbox-implementation-status-${path}`)).toHaveText(
        'unavailable',
      );
    }
    await expect(page.getByTestId('sandbox-fs-read')).toBeDisabled();
    await expect(page.getByTestId('sandbox-fs-write')).toBeDisabled();
    await expect(page.getByTestId('sandbox-resource-add')).toBeDisabled();
    await expect(page.getByTestId('sandbox-syscall-add')).toBeDisabled();
    await expect(page.getByTestId('sandbox-namespace-pid')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Network stays usable, but its restricted mode is measured unsupported.
    await page.getByTestId('sandbox-network-mode').click();
    await expect(page.getByTestId('sandbox-network-mode-deny')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByTestId('sandbox-network-mode-restricted')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('unknown/unsupported/offline never claim protection or offer Enter (#3124 SC-05)', async ({
    page,
  }) => {
    await openWebSandbox(page, '&sandbox=unknown');
    await expect(page.getByTestId('sandbox-unavailable')).toBeVisible();
    await expect(page.getByTestId('sandbox-status')).toHaveText('unknown');
    await expect(page.getByTestId('sandbox-enter')).toHaveCount(0);

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

  test('the composer and KV rows stay inside the pane (#3124 SC-06)', async ({ page }) => {
    await openWebSandbox(page, '');
    await page.getByTestId('sandbox-resource-add').click();
    await expect(page.getByTestId('sandbox-resource-row-0')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const input = await page.getByTestId('sandbox-resource-key-0').boundingBox();
    expect(input).not.toBeNull();
    expect(input!.x + input!.width).toBeLessThanOrEqual(1024);
  });
});

test.describe('App 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the confirmation is a full-width pushed page with one Back (#3124 SC-06)', async ({
    page,
  }) => {
    await openAppSandbox(page);
    await expect(page.getByTestId('sandbox-status')).toHaveText('outside');
    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await page.getByTestId('sandbox-enter').click();

    await expect(page.getByTestId('sandbox-confirm')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('Enter Sandbox');
    await expect(page.getByTestId('app-page-back')).toHaveCount(1);
    await expect(page.getByTestId('app-page-back')).toHaveAccessibleName('Back to Sandbox');

    await page.getByTestId('app-page-back').click();
    await expect(page.getByTestId('sandbox-composer')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('Sandbox');

    await page.getByTestId('sandbox-preflight').click();
    await expect(page.getByTestId('sandbox-preflight-ok')).toBeVisible();
    await page.getByTestId('sandbox-enter').click();
    await page.getByTestId('sandbox-confirm-enter').click();
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    await expect(page.getByTestId('app-page-header')).toContainText('Sandbox');
  });

  test('App shows implementation status and disables unmeasured controls (#3161 SC-04)', async ({
    page,
  }) => {
    await openAppSandbox(page, '?sandbox=macos');
    await expect(
      page.getByTestId('sandbox-implementation-status-filesystem.access'),
    ).toHaveText('unavailable');
    await expect(page.getByTestId('sandbox-fs-read')).toBeDisabled();
    await expect(page.getByTestId('sandbox-resource-add')).toBeDisabled();
    await expect(page.getByTestId('sandbox-syscall-add')).toBeDisabled();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('KV rows fit the phone pane and the scroller clears the capsule (#3124 SC-06)', async ({
    page,
  }) => {
    await openAppSandbox(page);
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

  test('the inside projection scrolls without horizontal overflow (#3124 SC-06)', async ({
    page,
  }) => {
    await openAppSandbox(page, '?sandbox=inside');
    await expect(page.getByTestId('sandbox-inside')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('sandbox-scope-note')).toBeVisible();
  });
});
