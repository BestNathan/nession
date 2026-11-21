'use strict';
// #4115 SC-02 (Env/Sandbox): the same endpoint contract for the Environment
// collection and the Sandbox configuration/deep detail form, including the
// document-host surface the App renders for ordinary content.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-02 Env and Sandbox endpoints clear the Capsule at every App width', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await helper.openWorkspace(page, 'env', '?env=many');
    const env = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(env, `Env ${viewport.id}`);
    helper.expectHostInset(env, `Env ${viewport.id}`);
    expect(env.host.mode, 'Env is a declared bounded surface').toBe('bounded');
    expect(env.lastActionable, 'the last Env profile remains actionable').not.toBeNull();

    await helper.openWorkspace(page, 'sandbox');
    await helper.growSandboxUntilScrolls(page);
    const sandbox = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(sandbox, `Sandbox ${viewport.id}`);
    helper.expectHostInset(sandbox, `Sandbox ${viewport.id}`);
    expect(sandbox.host.mode, 'Sandbox content flows in the host page scrollport').toBe('document');
    expect(sandbox.scroller.marked, 'the document surface is the host scroll owner').toBe(true);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the env=many profile collection '
      + 'and the grown Sandbox policy form (a deep detail) each scrolled their '
      + 'designated owner to maxScroll; the final painted content and the final '
      + 'actionable row cleared the Capsule top, the host published its own '
      + 'surface-derived scroll inset, and Env used the bounded adapter while '
      + 'Sandbox used the host page scrollport with no document scroll.',
  });
});
