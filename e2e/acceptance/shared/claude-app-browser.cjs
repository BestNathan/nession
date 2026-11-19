'use strict';
// Shared App navigation helpers for the #3829 Claude App Workspace Cases.
// The product, Server, Agent and tmux come from the exact target-SHA
// full-stack runner; these helpers only drive the shipped production Web build
// through its canonical App fixture route.

/**
 * Open the App fixture and land on Claude Code's Workspace.
 *
 * `search` names the provider input (`?conversation=…`, `?agents=offline`,
 * `?pane=…`); it never names a resolved screen.
 */
async function openClaudeApp(page, search = '') {
  // A repeated `goto` to the same URL+hash does not reload the SPA, so a
  // second Case step would land on the Workspace layer the first one left
  // open. Clearing the document first makes each open a fresh fixture mount.
  await page.goto('about:blank');
  await page.goto('/#/fixture/app' + search);
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.getByTestId('app-header-workspace').first().waitFor({ timeout: 30_000 });
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-claude-code').click({ timeout: 30_000 });
  await page.getByTestId('claude-code-app-workspace').waitFor({ timeout: 30_000 });
}

async function openBrowse(page) {
  await page.getByTestId('app-page-action').click();
  await page.getByTestId('claude-browse-sheet').waitFor({ timeout: 10_000 });
}

async function closeBrowse(page) {
  await page.keyboard.press('Escape');
  await page.getByTestId('claude-browse-sheet').waitFor({ state: 'hidden', timeout: 10_000 });
}

async function chooseBrowse(page, resource) {
  await openBrowse(page);
  await page.getByTestId('claude-browse-' + resource).click();
  await page.getByTestId('claude-browse-sheet').waitFor({ state: 'hidden', timeout: 10_000 });
}

async function back(page) {
  await page.getByTestId('app-page-back').click();
}

async function headerTitle(page) {
  return (await page.getByTestId('app-page-header').innerText()).trim();
}

/**
 * Measured boxes for the visible controls a touch surface offers.
 *
 * Scoped to the currently visible layer (`aria-hidden` is not used as a CSS
 * selector here; Playwright's `:visible` is) so a covered layer's rows do not
 * contaminate the measurement.
 */
async function visibleBoxes(page, selector) {
  return page.locator(selector + ':visible').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        testid: element.getAttribute('data-testid') || element.getAttribute('aria-label') || element.tagName,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
      };
    }),
  );
}

/** The App frame's horizontal overflow, which no phone width may introduce. */
async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-app-viewport-environment]');
    if (!(root instanceof HTMLElement)) return null;
    return {
      innerWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
    };
  });
}

/**
 * The scroll owner inside a named layer, or `null` when the layer has none.
 * Used for "Back restores the reader's place" rather than for styling.
 */
async function scrollOwner(page, layerTestId) {
  return page.evaluate((testId) => {
    const layer = document.querySelector('[data-testid="' + testId + '"]');
    if (!(layer instanceof HTMLElement)) return null;
    const candidates = [...layer.querySelectorAll('*')].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight
      );
    });
    const owner = candidates.find((element) => element.offsetParent !== null) || candidates[0];
    if (!owner) return null;
    return {
      scrollTop: owner.scrollTop,
      scrollHeight: owner.scrollHeight,
      clientHeight: owner.clientHeight,
    };
  }, layerTestId);
}

async function setScrollTop(page, layerTestId, top) {
  return page.evaluate(
    ({ testId, value }) => {
      const layer = document.querySelector('[data-testid="' + testId + '"]');
      if (!(layer instanceof HTMLElement)) throw new Error('layer not found: ' + testId);
      const owner = [...layer.querySelectorAll('*')].find((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          element.scrollHeight > element.clientHeight &&
          element.offsetParent !== null
        );
      });
      if (!owner) throw new Error('scroll owner not found in ' + testId);
      owner.scrollTop = value;
      return owner.scrollTop;
    },
    { testId: layerTestId, value: top },
  );
}

module.exports = {
  openClaudeApp,
  openBrowse,
  closeBrowse,
  chooseBrowse,
  back,
  headerTitle,
  visibleBoxes,
  horizontalOverflow,
  scrollOwner,
  setScrollTop,
};
