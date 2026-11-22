'use strict';
// #4222 SC-02 (real inner-scrollport geometry): every *designated* owner of a
// bounded App surface reaches its last painted and actionable content above the
// live Capsule, measured from that owner's own visible bottom. Sibling readers
// at different bottom coordinates (a list above a warnings footer; an editor
// above a feedback pane) each keep their own measured inset and neither
// reserves a blank tail for the other.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const helper = require('../../../shared/app-workspace-4115-browser.cjs');

const VARIABLES = '[data-testid="env-variable-list-scroll"]';
const WARNINGS = '[data-testid="env-var-warnings"]';
const EDITOR = '[data-testid="codemirror-editor"]';
const FEEDBACK = '[data-testid="env-editor-feedback"]';

async function openNoisyProfile(page) {
  await helper.openWorkspace(page, 'env', '?env=warnings');
  const row = page.getByTestId('env-profile-row-server::noisy.env');
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.getByTestId('env-variable-list-scroll').waitFor({ timeout: 30_000 });
}

async function measureAll(page, selectors, label) {
  const measurements = await helper.measureNamedScrollports(page, selectors);
  for (const { selector, state } of measurements) {
    helper.expectEndpoint(state, `${label} ${selector}`);
  }
  const bottoms = measurements.map(({ state }) => Math.round(state.scroller.bottom));
  expect(
    new Set(bottoms).size,
    `${label}: the designated owners are independent scrollports, not one inherited number`,
  ).toBeGreaterThan(1);
  return measurements;
}

test('SC-02 each split scrollport ends above the Capsule at its own bottom', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-02');

  for (const viewport of helper.appViewports()) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // ── Variables list + its warnings footer: two marked owners ──
    await openNoisyProfile(page);
    const listMeasurements = await measureAll(
      page,
      [VARIABLES, WARNINGS],
      `Env variables ${viewport.id}`,
    );
    expect(listMeasurements[0].state.scroller.bottom)
      .toBeLessThan(listMeasurements[1].state.scroller.bottom);
    const warnings = listMeasurements[1].state;
    expect(warnings.lastContent, 'the warnings owner paints content at its end').not.toBeNull();
    // Assert the *named* final warning, not whichever text leaf the generic
    // helper happened to sample: the last skipped line is the observable end.
    const lastWarning = page
      .locator('[data-testid="env-var-warnings"] p')
      .filter({ hasText: 'this line is not an assignment 23' });
    await expect(lastWarning).toHaveCount(1);
    const warningBox = await lastWarning.boundingBox();
    expect(warningBox, 'the final skipped-line warning is painted').not.toBeNull();
    expect(warningBox.y + warningBox.height, 'the final warning clears the Capsule')
      .toBeLessThanOrEqual((await helper.capsuleTop(page)) + 1);

    // ── Editor + expanded feedback: a reader above a second reader ──
    await page.getByTestId('env-edit').click();
    await page.locator('.cm-editor').waitFor({ timeout: 30_000 });
    await expect(page.locator('.cm-content')).toContainText('LONG_LIST_KEY_00');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nADDED_BY_4222=present');
    await page.getByTestId('env-editor-review').waitFor({ timeout: 30_000 });
    await page.getByTestId('env-editor-review').locator('summary').click();
    await page.getByTestId('env-editor-feedback').waitFor({ timeout: 30_000 });

    const editorMeasurements = await measureAll(
      page,
      [EDITOR, FEEDBACK],
      `Env editor ${viewport.id}`,
    );
    expect(editorMeasurements[0].state.scroller.bottom)
      .toBeLessThan(editorMeasurements[1].state.scroller.bottom);

    // The editor still owns focus/caret after the endpoint measurements.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Z');
    await expect(page.locator('.cm-content')).toContainText('Z');
    const focusedInEditor = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof Element && active.closest('.cm-editor') !== null;
    });
    expect(focusedInEditor, 'the editor retains the focused selection path').toBe(true);

    // No unexpected page scroll or horizontal overflow at either endpoint.
    const documentState = await page.evaluate(() => ({
      html: document.documentElement.scrollTop,
      body: document.body.scrollTop,
      width: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(documentState.html).toBe(0);
    expect(documentState.body).toBe(0);
    expect(documentState.width).toBeLessThanOrEqual(documentState.inner + 1);
  }

  test.info().annotations.push({
    type: 'evidence',
    description:
      `exact SHA ${sha}: at 375/390/430 an Environment variables list and its `
      + 'warnings footer, then the CodeMirror editor and its expanded feedback '
      + 'pane, were each scrolled to maxScroll. Each designated owner\'s final '
      + 'painted content and actionable control were no lower than the live '
      + 'Capsule top (1px), each owner\'s bottom differed from its sibling\'s, '
      + 'neither the document nor the body scrolled, and there was no horizontal '
      + 'overflow. The editor retained focus and caret after measurement.',
  });
});
