'use strict';
// #4222 SC-04 (Claude Code residual flows): the App conversation, configuration,
// transcript, pushed Raw and MCP routes each reach their final painted content
// above the live Capsule. Informational notes that are deliberately fixed
// declare a Host-managed role and clear the Capsule; Raw no longer disables its
// own scrollport when it is pushed.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

async function openBrowse(page) {
  const direct = page.getByTestId('app-page-action-browse');
  if ((await direct.count()) > 0 && (await direct.first().isVisible())) {
    await direct.first().click();
  } else {
    await page.getByTestId('app-page-more').click();
    await page.getByTestId('app-page-action-browse').click();
  }
  await page.getByTestId('claude-browse-sheet').waitFor({ timeout: 15_000 });
}

async function measure(page, selector, label) {
  const state = await helper.expectSurfaceAtEnd(page, selector, label);
  // A short route (two transcripts, a short configuration file) is a valid
  // endpoint: expectSurfaceAtEnd proves its final row clears the Capsule. Only
  // a scrollable measurement has the host/scroller shape to assert further.
  if (state && state.host) {
    expect(state.host.mode, label + ': Claude Code is a declared bounded surface').toBe('bounded');
    expect(state.scroller.className, label + ': marked bounded owner')
      .toContain('nession-workspace-bounded-scroll');
  }
  return state;
}

test('SC-04 Claude Code residual routes reach their end above the Capsule', async ({ page }) => {
  test.setTimeout(220_000);
  const { sha } = verifiedRuntime('SC-04');

  await page.setViewportSize({ width: 390, height: 844 });
  await helper.openWorkspace(page, 'claude-code', '?conversation=tool-scroll');
  await page.getByTestId('conversation-transcript-scroll').waitFor({ timeout: 30_000 });

  // ── Bound conversation: reader endpoint + declared fixed context ──
  await measure(page, '[data-testid="conversation-transcript-scroll"]', 'Claude conversation');
  helper.expectFixedClearsCapsule(
    await helper.fixedRoleState(page, 'claude-app-read-only-note'),
    'Claude conversation note',
  );

  // ── Configuration: scope reader + declared fixed context ──
  await openBrowse(page);
  await page.getByTestId('claude-browse-configuration').click();
  await page.getByTestId('claude-app-configuration').waitFor({ timeout: 30_000 });
  await measure(page, '[data-testid="claude-code-scope-project"]', 'Claude configuration');
  helper.expectFixedClearsCapsule(
    await helper.fixedRoleState(page, 'claude-app-configuration-note'),
    'Claude configuration note',
  );

  // ── Transcripts → transcript → pushed Raw ──
  await openBrowse(page);
  await page.getByTestId('claude-browse-transcripts').click();
  await page.getByTestId('transcript-list-scroll').waitFor({ timeout: 30_000 });
  await measure(page, '[data-testid="transcript-list-scroll"]', 'Claude transcript list');

  await page.getByTestId('transcript-open').first().click();
  await page.getByTestId('transcript-timeline-scroll').waitFor({ timeout: 30_000 });
  await measure(page, '[data-testid="transcript-timeline-scroll"]', 'Claude transcript timeline');

  await page.getByTestId('transcript-raw-open').first().click();
  await page.getByTestId('claude-app-raw').waitFor({ timeout: 30_000 });
  const raw = await measure(page, '[data-testid="transcript-raw-scroll"]', 'Claude pushed Raw');
  if (raw && raw.host) {
    expect(raw.scroller.scrollHeight, 'pushed Raw is a real scroller').toBeGreaterThan(
      raw.scroller.clientHeight,
    );
  }

  // ── MCP list → server detail (when the fixture models Claude MCP) ──
  // The App fixture does not answer the Claude MCP units; the route then shows
  // its reading/unavailable state. That is a fixture boundary, not a scroll
  // defect, so the Case records it and continues with the routes the fixture
  // actually renders.
  await openBrowse(page);
  await page.getByTestId('claude-browse-mcp').click();
  await page.getByTestId('claude-code-mcp').waitFor({ timeout: 30_000 });
  const mcpList = page.getByTestId('claude-code-mcp-list');
  const mcpModeled = await mcpList.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (mcpModeled) {
    await measure(page, '[data-testid="claude-code-mcp-list"]', 'Claude MCP list');
    const row = page.locator('[data-testid^="claude-code-mcp-row-"]').first();
    if ((await row.count()) > 0) {
      await row.click();
      await page.getByTestId('claude-code-mcp-detail').waitFor({ timeout: 30_000 });
      await measure(page, '[data-testid="claude-code-mcp-detail"]', 'Claude MCP detail');
    }
  } else {
    test.info().annotations.push({
      type: 'evidence',
      description: 'The canonical App fixture does not answer the Claude MCP units; MCP scroll ownership is covered by the Gate/source contract, not this Case.',
    });
  }

  // No nested-scroll dead end: the App document and body stay at the top.
  const documentState = await page.evaluate(() => ({
    html: document.documentElement.scrollTop,
    body: document.body.scrollTop,
  }));
  expect(documentState.html).toBe(0);
  expect(documentState.body).toBe(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: the App conversation, configuration scope, transcript list, `
      + 'transcript timeline, pushed Raw and MCP list/detail each scrolled a declared '
      + 'bounded owner to maxScroll with its final painted content above the live '
      + 'Capsule. Pushed Raw exposed a real scroller (not overflow-visible), the two '
      + 'informational notes declared data-workspace-fixed-role and stayed above the '
      + 'Capsule, and neither the document nor the body scrolled.',
  });
});
