'use strict';
// #4222 SC-05 (eight-capability cross-page regression): every currently
// reachable App Workspace capability scrolls its declared surface to a real
// endpoint at the canonical phone widths, a landscape/short-height condition,
// with no document/body scroll and no horizontal overflow. Web master/detail is
// covered by the repository's ui-contract-matrix regression Case, not restated
// here against the App fixture.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

/** Each capability with the fixture input its long/representative state needs. */
const CAPABILITIES = [
  { id: 'files', search: '', mode: 'bounded', seedFiles: true },
  { id: 'session', search: '', mode: 'document' },
  { id: 'agent', search: '', mode: 'document' },
  { id: 'env', search: '?env=warnings', mode: 'bounded', openProfile: true },
  { id: 'sandbox', search: '', mode: 'document', growSandbox: true },
  { id: 'claude-code', search: '?conversation=rich', mode: 'bounded' },
  { id: 'git', search: '?git=many', mode: 'bounded' },
  { id: 'project', search: '?projects=canonical&sessionProject=bound', mode: 'document' },
];

async function openCapability(page, capability) {
  if (capability.seedFiles) {
    await helper.openFilesLong(page, capability.search);
    return;
  }
  await helper.openWorkspace(page, capability.id, capability.search);
  if (capability.openProfile) {
    await page.getByTestId('env-profile-row-server::noisy.env').click({ timeout: 30_000 });
    await page.getByTestId('env-variable-list-scroll').waitFor({ timeout: 30_000 });
  }
  if (capability.growSandbox) {
    await helper.growSandboxUntilScrolls(page);
  }
}

async function assertEndpoint(page, capability, label) {
  if (capability.mode === 'bounded') {
    // A bounded page must expose a real internal owner; wait for its content
    // to arrive rather than letting an immediate probe call a loading page
    // "short".
    const state = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(state, label);
    helper.expectHostInset(state, label);
    expect(state.host.mode, `${label}: the declared surface mode`).toBe('bounded');
    expect(state.scroller.className, `${label}: a marked bounded owner`)
      .toContain('nession-workspace-bounded-scroll');
    return state;
  }

  const state = await helper.expectSurfaceAtEnd(page, null, label);
  if (state && state.host) {
    helper.expectHostInset(state, label);
    expect(state.host.mode, `${label}: the declared surface mode`).toBe('document');
    expect(state.scroller.testid, `${label}: the host page scrollport`).toBe(
      'app-workspace-scrollport',
    );
  } else {
    // A short document route has no overflowing scroller; its surface mode is
    // still the host's declaration and its final row was proven above the
    // Capsule by expectSurfaceAtEnd.
    const mode = await page.evaluate(() => (
      document.querySelector('[data-workspace-app-surface]')
        ?.getAttribute('data-workspace-app-surface') ?? null
    ));
    expect(mode, `${label}: the declared surface mode`).toBe('document');
  }
  return state;
}

test('SC-05 every App Workspace capability reaches its end at each viewport', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-05');

  const viewports = [...helper.appViewports(), helper.landscapeViewport()];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const capability of CAPABILITIES) {
      await openCapability(page, capability);
      await assertEndpoint(page, capability, `${capability.id} ${viewport.id}`);
    }
  }

  // A representative long flow still works with focus/Back: the App Files
  // viewer is pushed and Back restores the directory's owner.
  await page.setViewportSize({ width: 390, height: 844 });
  await helper.openFilesLong(page);
  await helper.expectSurfaceAtEnd(page, '[data-testid="files-app-list"]', 'Files pushed directory');
  await page.getByTestId('app-page-back').click();
  await page.getByTestId('files-app-list').waitFor({ timeout: 30_000 });
  await helper.expectSurfaceAtEnd(page, '[data-testid="files-app-list"]', 'Files after Back');

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: Files, Session, Agent, Environment, Sandbox, Claude Code, `
      + 'Git and Project were each opened from the shipped App fixture and scrolled '
      + 'to their declared endpoint at 375/390/430 and the canonical landscape/short '
      + 'height viewport. Each route\'s declared mode matched the rendered surface '
      + '(document page scrollport or a marked bounded owner), the final painted '
      + 'content was above the Capsule, and neither document/body scroll nor '
      + 'horizontal overflow appeared. A pushed Files directory and its Back return '
      + 'both scrolled to their end.',
  });
});
