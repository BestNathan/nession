'use strict';
// #4188 SC-02 (GitHub nested readers): at the canonical App phone widths, the
// Issues / Pull Requests lists, their pushed readers and the Actions list each
// scroll their own declared bounded owner to the end above the live Capsule
// top — before and after a route change and a viewport-geometry change — with
// no hardcoded-height clearance, document scroll or horizontal overflow.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

const ISSUE_LIST = '[data-testid="github-issue-list-scroll"]';
const ISSUE_READER = '[data-testid="github-issue-reader-scroll"]';
const PR_LIST = '[data-testid="github-pr-list-scroll"]';
const PR_READER = '[data-testid="github-pr-reader-scroll"]';
const ACTIONS = '[data-testid="github-actions-scroll"]';

async function measure(page, selector, label) {
  const state = await helper.scrollToEndAndMeasure(page, selector);
  helper.expectEndpoint(state, label);
  helper.expectHostInset(state, label);
  expect(state.host.mode, label + ': Git is a declared bounded surface').toBe('bounded');
  expect(state.scroller.className, label + ': marked bounded owner')
    .toContain('nession-workspace-bounded-scroll');
  expect(state.scroller.className, label + ': no fixed Capsule band')
    .not.toContain('pb-16');
  return state;
}

test('SC-02 nested GitHub lists and readers clear the Capsule', async ({ page }) => {
  test.setTimeout(200_000);
  const { sha } = verifiedRuntime('SC-02');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await helper.openWorkspace(page, 'git', '?github=long');
    await page.getByTestId('git-surface-github').click();

    // ── Issues list and reader ──
    await page.getByTestId('github-issue-row-4001').waitFor({ timeout: 30_000 });
    await measure(page, ISSUE_LIST, `Issues list ${viewport.id}`);
    await page.getByTestId('github-issue-row-4001').click();
    await page.getByTestId('github-issue-detail-4001').waitFor({ timeout: 30_000 });
    const issueReader = await measure(page, ISSUE_READER, `Issue reader ${viewport.id}`);
    expect(
      issueReader.lastContent.bottom,
      'the final reader content clears the Capsule',
    ).toBeLessThanOrEqual(issueReader.capsuleTop + helper.ROUNDING_TOLERANCE_PX);
    await page.getByTestId('github-back-to-list').click();
    await page.getByTestId('github-issue-list-scroll').waitFor({ timeout: 30_000 });

    // ── Pull Requests list and reader ──
    await page.getByTestId('github-tab-pull-requests').click();
    await page.getByTestId('github-pr-row-5001').waitFor({ timeout: 30_000 });
    await measure(page, PR_LIST, `Pull Requests list ${viewport.id}`);
    await page.getByTestId('github-pr-row-5001').click();
    await page.getByTestId('github-pr-detail-5001').waitFor({ timeout: 30_000 });
    await measure(page, PR_READER, `Pull Request reader ${viewport.id}`);
    await page.getByTestId('github-back-to-list').click();

    // ── Actions list ──
    await page.getByTestId('github-tab-actions').click();
    await page.getByTestId('github-workflow-7001').waitFor({ timeout: 30_000 });
    await measure(page, ACTIONS, `Actions list ${viewport.id}`);

    // ── Route change back to Issues, then a geometry change ──
    await page.getByTestId('github-tab-issues').click();
    await page.getByTestId('github-issue-row-4001').waitFor({ timeout: 30_000 });
    await measure(page, ISSUE_LIST, `Issues list after route change ${viewport.id}`);

    await page.setViewportSize({
      width: viewport.width,
      height: Math.max(480, viewport.height - 140),
    });
    await measure(page, ISSUE_LIST, `Issues list after geometry change ${viewport.id}`);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the long `github=long` Issues list, '
      + 'an Issue reader, the Pull Requests list, a Pull Request reader and the '
      + 'Actions list each scrolled their own marked bounded owner to maxScroll; '
      + 'the final painted/actionable content was no lower than the live Capsule '
      + 'top (1px tolerance), the host scroll inset matched the measured surface '
      + 'geometry, no fixed pb-16 band remained, and neither document nor body '
      + 'scrolled or overflowed horizontally. The Issues list was measured again '
      + 'after a section route change and after a viewport-height change. '
      + 'No physical-device safe-area or Safari claim is made.',
  });
});
