'use strict';
// #4115 SC-02 (Files/Git): at the canonical App phone widths, scrolling the
// designated primary owner of long Files and Git content to its end leaves the
// final visible content and control entirely above the real Capsule top, with
// the host's measured scroll inset derived from its own surface geometry, no
// document scroll, no horizontal overflow and no unscrollable blank tail.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

test('SC-02 Files and Git endpoints clear the Capsule at every App width', async ({ page }) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-02');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await helper.openFilesLong(page);
    const files = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(files, `Files ${viewport.id}`);
    helper.expectHostInset(files, `Files ${viewport.id}`);
    expect(files.host.mode, 'Files is a declared bounded surface').toBe('bounded');
    expect(files.scroller.className).toContain('nession-workspace-bounded-scroll');
    expect(files.lastActionable, 'the last Files row remains actionable').not.toBeNull();

    await helper.openWorkspace(page, 'git', '?git=many');
    const git = await helper.scrollToEndAndMeasure(page);
    helper.expectEndpoint(git, `Git ${viewport.id}`);
    helper.expectHostInset(git, `Git ${viewport.id}`);
    expect(git.host.mode, 'Git is a declared bounded surface').toBe('bounded');
    expect(git.scroller.className).toContain('nession-workspace-bounded-scroll');
    expect(git.lastActionable, 'the last Git change remains actionable').not.toBeNull();
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 a long Files directory and '
      + 'git=many change list each scrolled their declared bounded owner to '
      + 'maxScroll; the final painted content and the final actionable row were '
      + 'no lower than the Capsule top (1px tolerance), the host scroll inset '
      + 'matched its own surface-to-bar geometry, the actions inset equalled the '
      + 'whole band, and neither the document nor the body scrolled or '
      + 'overflowed horizontally.',
  });
});
