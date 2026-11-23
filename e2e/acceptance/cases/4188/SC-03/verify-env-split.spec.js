'use strict';
// #4188 SC-03 (Env split surfaces): at the canonical App phone widths, a long
// Variables list with many skipped-line warnings reaches the final warning
// above the Capsule inside its own bounded owner; the Profile Editor keeps
// CodeMirror usable while its warnings and expanded Review-changes diff stay
// reachable in a sibling bounded feedback owner; a viewport-geometry change
// neither hides controls nor breaks the scroll endpoint.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

const VARIABLES = '[data-testid="env-variable-list-scroll"]';
const WARNINGS = '[data-testid="env-var-warnings"]';
const FEEDBACK = '[data-testid="env-editor-feedback"]';

async function measure(page, selector, label) {
  const state = await helper.scrollToEndAndMeasure(page, selector);
  helper.expectEndpoint(state, label);
  helper.expectHostInset(state, label);
  expect(state.host.mode, label + ': Environment is a declared bounded surface').toBe('bounded');
  expect(state.scroller.className, label + ': marked bounded owner')
    .toContain('nession-workspace-bounded-scroll');
  return state;
}

test('SC-03 Env variables and editor feedback clear the Capsule', async ({ page }) => {
  test.setTimeout(200_000);
  const { sha } = verifiedRuntime('SC-03');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await helper.openWorkspace(page, 'env', '?env=warnings');
    const row = page.getByTestId('env-profile-row-server::noisy.env');
    await row.waitFor({ timeout: 30_000 });
    await row.click();
    await page.getByTestId('env-variable-list-scroll').waitFor({ timeout: 30_000 });

    // ── Variables list and its pinned warnings footer ──
    await measure(page, VARIABLES, `Env variables list ${viewport.id}`);
    const warnings = await measure(page, WARNINGS, `Env warnings ${viewport.id}`);
    expect(warnings.lastContent, 'a final warning is painted').not.toBeNull();
    // The helper reports a 48-character excerpt; the last skipped line is the
    // 24th warning (file line 60), so its line id is the stable reachable-end
    // marker without depending on text past the excerpt.
    expect(warnings.lastContent.text, 'the last warning is the reachable end')
      .toContain('line 60:');

    // ── Editor: warnings + expanded Review changes in the feedback owner ──
    await page.getByTestId('env-edit').click();
    await page.locator('.cm-editor').waitFor({ timeout: 30_000 });
    // Wait for the profile source itself, not merely the editor host: typing
    // into an empty pre-load buffer would be replaced by the arriving content.
    await expect(page.locator('.cm-content')).toContainText('LONG_LIST_KEY_00');
    expect(page.getByTestId('env-editor-save'), 'the App action stays visible').toBeVisible();

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nADDED_BY_4188=present');
    await page.getByTestId('env-editor-review').waitFor({ timeout: 30_000 });
    await page.getByTestId('env-editor-review').locator('summary').click();
    await page.getByTestId('env-editor-feedback').waitFor({ timeout: 30_000 });

    const feedback = await measure(page, FEEDBACK, `Env editor feedback ${viewport.id}`);
    expect(feedback.lastContent, 'the expanded diff has painted content').not.toBeNull();
    expect(feedback.scroller.testid).toBe('env-editor-feedback');

    // The editor still owns its caret/selection path after the endpoint measure.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Z');
    await expect(page.locator('.cm-content')).toContainText('Z');
    const selectionInsideEditor = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof Element && active.closest('.cm-editor') !== null;
    });
    expect(selectionInsideEditor, 'the editor still owns the focused selection path').toBe(true);

    // ── Viewport geometry change: the endpoint is re-derived, not stale ──
    await page.setViewportSize({
      width: viewport.width,
      height: Math.max(480, viewport.height - 140),
    });
    const resized = await measure(page, FEEDBACK, `Env editor feedback after resize ${viewport.id}`);
    expect(resized.lastContent.bottom, 'the resized feedback still clears the Capsule')
      .toBeLessThanOrEqual(resized.capsuleTop + helper.ROUNDING_TOLERANCE_PX);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': at 375/390/430 the `env=warnings` Variables list '
      + 'scrolled its marked bounded owner to maxScroll and the pinned warnings '
      + 'footer scrolled its own marked owner to a final skipped-line warning '
      + 'above the Capsule top; the Profile Editor kept '
      + 'CodeMirror focused and accepted text after its sibling feedback owner '
      + '(warnings plus expanded Review changes) was scrolled to its own end; '
      + 'the host scroll inset matched the measured surface geometry before and '
      + 'after a viewport-height change, and neither document nor body scrolled '
      + 'or overflowed horizontally. Physical keyboard/safe-area behavior and '
      + 'native Safari are not claimed; Chromium viewport geometry is the proof.',
  });
});
