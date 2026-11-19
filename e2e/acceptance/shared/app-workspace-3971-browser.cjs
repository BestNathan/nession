'use strict';
// Shared browser machinery for the #3971 App Workspace Cases.
//
// The product, Server, Agent and tmux come from the exact target-SHA
// full-stack runner. These helpers drive the shipped production Web build
// through its canonical App fixture route and only read what the product
// publishes: the one App header, the Workspace content roles and the gesture
// coordinator's observable `data-swipe-*` / `data-workspace-stack-*` state.

/* eslint-disable @typescript-eslint/no-require-imports */
const viewports = require('../../../design/contracts/viewports.json');

const APP_WIDTHS = [375, 390, 430];

/** The canonical App phone rows #3971 is proven at. */
function appViewports() {
  return APP_WIDTHS.map((width) => {
    const row = viewports.viewports.find(
      (candidate) => candidate.experience === 'app' && candidate.width === width,
    );
    if (!row) {
      throw new Error('canonical App viewport ' + width + ' is missing');
    }
    return row;
  });
}

async function openApp(page, search = '') {
  // A repeated goto to the same URL+hash does not reload the SPA; clearing the
  // document makes each open a fresh fixture mount.
  await page.goto('about:blank');
  await page.goto('/#/fixture/app' + search);
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.getByTestId('app-header-workspace').first().waitFor({ timeout: 30_000 });
}

async function openWorkspace(page, capability, search = '') {
  await openApp(page, search);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-' + capability).click({ timeout: 30_000 });
  await page.getByTestId('workspace-shell').waitFor({ timeout: 30_000 });
}

async function header(page) {
  const one = page.getByTestId('app-page-header');
  if ((await one.count()) !== 1) {
    throw new Error('expected exactly one App page header, found ' + (await one.count()));
  }
  return one;
}

async function headerText(page) {
  return (await (await header(page)).innerText()).trim();
}

async function subtitleText(page) {
  return (await page.getByTestId('app-page-subtitle-text').innerText()).trim();
}

/** Mark the mounted xterm so a navigation cannot silently replace it. */
async function markTerminal(page) {
  await page.locator('.xterm').first().waitFor({ timeout: 30_000 });
  await page
    .locator('.xterm')
    .first()
    .evaluate((element) => element.setAttribute('data-3971-terminal', 'original'));
}

function terminalMarkedCount(page) {
  return page.locator('.xterm[data-3971-terminal="original"]').count();
}

/** The App page's horizontal overflow (no phone width may introduce any). */
async function pageOverflow(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
  }));
}

/**
 * The visible scroll owners inside `rootSelector`.
 *
 * A screen has one intended reading direction; a second visible vertical
 * scroller is the failure this measures. Hidden covered layers are excluded.
 */
async function visibleScrollOwners(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!(root instanceof HTMLElement)) return null;
    return [...root.querySelectorAll('*')].filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.offsetParent === null) return false;
      const style = getComputedStyle(element);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight
      );
    }).length;
  }, rootSelector);
}

/** A non-interactive point inside `selector`, for a gesture that must be claimed. */
async function contentPoint(page, selector, { fx = 0.5, fy = 0.25 } = {}) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error('missing layout for ' + selector);
  }
  return {
    x: Math.round(box.x + box.width * fx),
    y: Math.round(box.y + box.height * fy),
  };
}

/** Measure the visible icons/actions a Case asserts touch geometry on. */
async function boxes(page, selector) {
  return page.locator(selector + ':visible').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        testid: element.getAttribute('data-testid') || element.getAttribute('aria-label'),
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        label: element.getAttribute('aria-label'),
      };
    }),
  );
}

module.exports = {
  appViewports,
  openApp,
  openWorkspace,
  header,
  headerText,
  subtitleText,
  markTerminal,
  terminalMarkedCount,
  pageOverflow,
  visibleScrollOwners,
  contentPoint,
  boxes,
};
