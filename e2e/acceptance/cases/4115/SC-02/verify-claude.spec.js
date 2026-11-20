'use strict';
// #4115 SC-02 (Claude): the Reader/Transcript stack keeps its own scroll owner
// but still receives the host's measured trailing clearance; the last painted
// transcript content clears the Capsule at the real end of scroll.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-02 the Claude reader endpoint clears the Capsule at every App width', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await helper.openWorkspace(page, 'claude-code', '?conversation=rich');
    await page.getByTestId('claude-app-reader-surface').waitFor({ timeout: 30_000 });
    const reader = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(reader, `Claude reader ${viewport.id}`);
    helper.expectHostInset(reader, `Claude reader ${viewport.id}`);
    expect(reader.host.mode, 'the Claude stack is a declared bounded surface').toBe('bounded');
    expect(reader.scroller.className).toContain('nession-workspace-bounded-scroll');
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the rich Claude conversation '
      + 'reader scrolled its own bounded transcript owner to maxScroll; the last '
      + 'painted transcript content cleared the Capsule top, the host scroll '
      + 'inset matched the bounded region-to-bar geometry, and neither the '
      + 'document nor the body scrolled.',
  });
});
