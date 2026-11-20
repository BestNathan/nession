'use strict';
// Shared browser machinery for the #4115 App Workspace scrolling Cases.
//
// The product, Server, Agent and tmux come from the exact target-SHA
// full-stack runner. These helpers drive the shipped production Web build
// through its canonical App fixture route and read only what the product
// publishes: the one App page header, the host's `data-workspace-app-surface`
// role, the declared bounded scroll marker and the floating Capsule bar.
//
// Geometry is measured from the element that actually scrolls after
// `scrollTop = scrollHeight - clientHeight`, against the Capsule bar's real
// top. A `content-visibility` subtree can report geometry for unpainted
// offscreen content, so candidates are also required to be the element
// `document.elementFromPoint` hits at their centre.

/* eslint-disable @typescript-eslint/no-require-imports */
const { expect } = require('@playwright/test');
const viewports = require('../../../design/contracts/viewports.json');

const PORTRAIT_WIDTHS = [375, 390, 430];
/** A measured blank tail beyond the final painted content this Case tolerates. */
const MAX_BLANK_TAIL_PX = 64;
/** The SC's 1px rounding allowance. */
const ROUNDING_TOLERANCE_PX = 1;

function appViewports() {
  return PORTRAIT_WIDTHS.map((width) => {
    const row = viewports.viewports.find(
      (candidate) => candidate.experience === 'app' && candidate.width === width,
    );
    if (!row) {
      throw new Error('canonical App viewport ' + width + ' is missing');
    }
    return row;
  });
}

function landscapeViewport() {
  const row = viewports.viewports.find(
    (candidate) => candidate.experience === 'app' && candidate.width > candidate.height,
  );
  if (!row) {
    throw new Error('canonical App landscape viewport is missing');
  }
  return row;
}

async function openApp(page, search = '') {
  // A repeated goto to the same URL+hash does not reload the SPA; clearing the
  // document makes each open a fresh fixture mount.
  await page.goto('about:blank');
  await page.goto('/#/fixture/app' + search);
  await page.getByTestId('app-layer-root').waitFor({ timeout: 30_000 });
  await page.getByTestId('app-header-workspace').first().waitFor({ timeout: 30_000 });
}

/** Seed the deterministic long Files tree (#3738) before the App mounts it. */
async function seedLongFiles(page) {
  await page.evaluate(() => {
    const control = window.fixtureFiles;
    if (!control || typeof control.seedSearchForest !== 'function') {
      throw new Error('fixtureFiles.seedSearchForest is unavailable');
    }
    control.seedSearchForest({ filesBeforeMatch: 60 });
  });
}

async function openWorkspace(page, capability, search = '') {
  await openApp(page, search);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-' + capability).click({ timeout: 30_000 });
  await page.getByTestId('workspace-shell').waitFor({ timeout: 30_000 });
}

/**
 * Seed a long editable source file the product can actually open. `writeExternal`
 * is the fixture's stand-in for a writer outside the App (the same control the
 * viewer's competing-write Cases use); the tree stays a reachable Files state.
 */
async function seedLongEditableFile(page) {
  await seedLongFiles(page);
  await page.evaluate(() => {
    const control = window.fixtureFiles;
    if (!control || typeof control.writeExternal !== 'function') {
      throw new Error('fixtureFiles.writeExternal is unavailable');
    }
    control.writeExternal(
      'bulk/long.ts',
      Array.from({ length: 400 }, (_, index) => `export const line${index} = ${index};`).join('\n'),
    );
  });
}

/** Files at its long root, then inside the seeded `bulk/` directory. */
async function openFilesLong(page, search = '') {
  await openApp(page, search);
  await seedLongFiles(page);
  await page.getByTestId('app-header-workspace').first().click();
  await page.getByTestId('workspace-tool-files').click({ timeout: 30_000 });
  await page.getByTestId('workspace-shell').waitFor({ timeout: 30_000 });
  await page.getByTestId('file-row-bulk').click({ timeout: 30_000 });
  await page.getByTestId('files-app-list').waitFor({ timeout: 30_000 });
}

/** Grow a repeatable Sandbox form until the designated surface overflows. */
async function growSandboxUntilScrolls(page, limit = 40) {
  await page.getByTestId('sandbox-section-policies').click();
  await page.getByTestId('sandbox-tab-filesystem').click();
  for (let index = 0; index < limit; index += 1) {
    const overflowing = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="workspace-tool-content"]');
      if (!(content instanceof HTMLElement)) return false;
      return [content, ...content.querySelectorAll('*')].some((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          element.scrollHeight > element.clientHeight + 1
        );
      });
    });
    if (overflowing) return;
    await page.getByTestId('sandbox-fs-read-add').click();
  }
  throw new Error('the Sandbox policy form never overflowed');
}

async function capsuleTop(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="workspace-tool-bar"]');
    if (bar instanceof HTMLElement) {
      return bar.getBoundingClientRect().top;
    }
    const shell = document.querySelector('[data-testid="workspace-shell"]');
    return shell instanceof HTMLElement ? shell.getBoundingClientRect().bottom : window.innerHeight;
  });
}

/**
 * Scroll the designated primary owner to its end and measure the endpoint.
 *
 * The primary owner is the visible vertical scroller with the largest client
 * height inside `workspace-tool-content`; that is the Host page scrollport for
 * a document view and the declared internal scroller for a bounded view. A
 * split surface may have more than one legitimate owner (#4188), so a Case can
 * name the exact element it is measuring instead of relying on size.
 */
async function scrollToEndAndMeasure(page, targetSelector = null) {
  // A virtualized/lazily-rendered reader (the Git patch renderer is one) can
  // report a full-height but empty body for a frame. Wait for the designated
  // surface to really overflow before measuring; the Case should not encode a
  // guess about how many frames a renderer needs.
  await page.waitForFunction((selector) => {
    if (selector) {
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLElement) || target.offsetParent === null) return false;
      const style = getComputedStyle(target);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        target.scrollHeight > target.clientHeight + 1
      );
    }
    const content = document.querySelector('[data-testid="workspace-tool-content"]');
    if (!(content instanceof HTMLElement)) return false;
    return [content, ...content.querySelectorAll('*')].some((element) => {
      if (!(element instanceof HTMLElement) || element.offsetParent === null) return false;
      const style = getComputedStyle(element);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight + 1
      );
    });
  }, targetSelector, { timeout: 20_000 });
  return page.evaluate((selector) => {
    const content = document.querySelector('[data-testid="workspace-tool-content"]');
    const shell = document.querySelector('[data-testid="workspace-shell"]');
    const bar = document.querySelector('[data-testid="workspace-tool-bar"]');
    if (!(content instanceof HTMLElement)) {
      throw new Error('workspace-tool-content is missing');
    }
    const visible = (element) => element instanceof HTMLElement
      && element.offsetParent !== null
      && element.closest('[data-covered="true"]') === null
      && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none';
    let named = null;
    if (selector) {
      const candidate = document.querySelector(selector);
      if (!(candidate instanceof HTMLElement) || !visible(candidate)) {
        throw new Error('named scroll owner is missing or hidden: ' + selector);
      }
      const style = getComputedStyle(candidate);
      if (
        (style.overflowY !== 'auto' && style.overflowY !== 'scroll') ||
        candidate.scrollHeight <= candidate.clientHeight + 1
      ) {
        throw new Error('named scroll owner does not scroll: ' + selector);
      }
      named = candidate;
    }
    const scrollers = [content, ...content.querySelectorAll('*')].filter((element) => {
      if (!visible(element)) return false;
      const style = getComputedStyle(element);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight + 1
      );
    });
    const scroller = named ?? scrollers.sort(
      (a, b) => b.clientHeight - a.clientHeight,
    )[0];
    if (!scroller) {
      throw new Error('no vertical scroll owner in the Workspace content');
    }

    const rect = scroller.getBoundingClientRect();
    const style = getComputedStyle(scroller);
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
    const contentEnd = rect.bottom - paddingBottom - borderBottom;

    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;

    const painted = (node) => {
      if (!visible(node) || node.closest('[data-covered="true"]')) return false;
      const r = node.getBoundingClientRect();
      if (!(r.height > 0 && r.width > 0)) return false;
      // Sample the centre of the box's visible intersection with the scroller:
      // a tall renderer host has its box centre off-screen even though its
      // final lines are the painted content at the end of the scroll.
      const visibleTop = Math.max(r.top, rect.top);
      const visibleBottom = Math.min(r.bottom, rect.bottom);
      const visibleLeft = Math.max(r.left, rect.left);
      const visibleRight = Math.min(r.right, rect.right);
      // Literal 1: this function runs in the page, where module constants of
      // the Node harness do not exist.
      if (visibleBottom <= visibleTop + 1 || visibleRight <= visibleLeft + 1) {
        return false;
      }
      const x = Math.min(
        window.innerWidth - 1,
        Math.max(0, (visibleLeft + visibleRight) / 2),
      );
      const y = Math.min(
        window.innerHeight - 1,
        Math.max(0, (visibleTop + visibleBottom) / 2),
      );
      const hit = document.elementFromPoint(x, y);
      return hit instanceof Element && (hit === node || node.contains(hit));
    };

    const actionableSelector =
      'button, a, input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])';
    const measure = (nodes) => nodes
      .filter(painted)
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .sort((a, b) => b.rect.bottom - a.rect.bottom);
    const actionable = measure([...scroller.querySelectorAll(actionableSelector)]);
    const controls = measure([...scroller.querySelectorAll('button, a, [role="button"]')]);
    const textLeaves = measure(
      [...scroller.querySelectorAll('*')].filter(
        (node) => node.children.length === 0 && (node.textContent || '').trim().length > 0,
      ),
    );
    // "Final content" is the lower of the last painted text and the last
    // painted control: a row's own text may sit a few pixels above its
    // button's box, and an informational tail may have no control at all.
    // A renderer with its content in a shadow root (the Git patch renderer is
    // one) exposes no light-DOM text; its painted host element is the content
    // boundary the user actually sees, so fall back to painted elements only
    // when there is no text/control at all.
    let contentCandidates = [...textLeaves, ...controls].sort(
      (a, b) => b.rect.bottom - a.rect.bottom,
    );
    if (contentCandidates.length === 0) {
      contentCandidates = measure([...scroller.querySelectorAll('*')])
        .filter((entry) => entry.rect.height > 0);
    }

    const describe = (entry) => entry === undefined
      ? null
      : {
        testid: entry.node.getAttribute('data-testid'),
        text: (entry.node.textContent || '').trim().slice(0, 48),
        top: entry.rect.top,
        bottom: entry.rect.bottom,
      };
    const lastActionable = actionable[0] ?? controls[0];
    const lastContent = contentCandidates[0];

    const capsule = bar instanceof HTMLElement
      ? bar.getBoundingClientRect().top
      : (shell instanceof HTMLElement ? shell.getBoundingClientRect().bottom : window.innerHeight);

    return {
      capsuleTop: capsule,
      scroller: {
        testid: scroller.getAttribute('data-testid'),
        className: String(scroller.className),
        top: rect.top,
        bottom: rect.bottom,
        paddingBottom,
        borderBottom,
        contentEnd,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
        marked: scroller.getAttribute('data-workspace-scroll-owner') === 'true',
      },
      lastActionable: describe(lastActionable),
      lastContent: describe(lastContent),
      endpoint: lastContent?.rect.bottom ?? null,
      host: shell instanceof HTMLElement
        ? {
          mode: document.querySelector('[data-workspace-app-surface]')?.getAttribute('data-workspace-app-surface') ?? null,
          surfaceBottom: document.querySelector('[data-workspace-app-surface]')?.getBoundingClientRect().bottom ?? null,
          scrollInset: getComputedStyle(shell).getPropertyValue('--nession-local-workspace-scroll-bottom-inset').trim(),
          contentInset: getComputedStyle(shell).getPropertyValue('--nession-local-workspace-content-bottom-inset').trim(),
          actionsInset: getComputedStyle(shell).getPropertyValue('--nession-local-workspace-actions-bottom-inset').trim(),
        }
        : null,
      document: {
        htmlScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
    };
  });
}

/** The SC-02 endpoint contract for one measured flow. */
function expectEndpoint(state, label) {
  expect(state.scroller, label + ': a designated scroll owner').not.toBeNull();
  expect(state.scroller.scrollTop, label + ': scrolled to the actual end').toBe(state.scroller.maxScroll);
  expect(state.lastContent, label + ': painted content at the end').not.toBeNull();
  expect(state.lastContent.bottom, label + ': final content clears the Capsule')
    .toBeLessThanOrEqual(state.capsuleTop + ROUNDING_TOLERANCE_PX);
  if (state.lastActionable) {
    expect(state.lastActionable.bottom, label + ': final actionable control clears the Capsule')
      .toBeLessThanOrEqual(state.capsuleTop + ROUNDING_TOLERANCE_PX);
  }
  expect(state.lastContent.bottom, label + ': no unscrollable blank tail')
    .toBeGreaterThanOrEqual(state.scroller.contentEnd - MAX_BLANK_TAIL_PX);
  expect(state.document.htmlScrollTop, label + ': the document does not scroll').toBe(0);
  expect(state.document.bodyScrollTop, label + ': the body does not scroll').toBe(0);
  expect(state.document.scrollWidth, label + ': no horizontal overflow')
    .toBeLessThanOrEqual(state.document.innerWidth + 1);
}

/**
 * The host's published scroll inset is derived from the App surface that is
 * actually there, not from a capability constant (#4115).
 */
function expectHostInset(state, label) {
  expect(state.host, label + ': the App host publishes its insets').not.toBeNull();
  const scrollInset = Number.parseFloat(state.host.scrollInset);
  const expected = Math.max(0, state.host.surfaceBottom - state.capsuleTop);
  expect(Number.isFinite(scrollInset), label + ': scroll inset is a px value').toBe(true);
  expect(Math.abs(scrollInset - expected), label + ': scroll inset follows the surface')
    .toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
  expect(state.host.actionsInset, label + ': the actions band is the whole floating band')
    .toBe(state.host.contentInset);
}

/** Long-press a Files row through the row's own pointer contract. */
async function longPress(page, selector) {
  const row = page.locator(selector);
  if ((await row.count()) === 0) {
    throw new Error('row not found for long press: ' + selector);
  }
  await row.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0, buttons: 1 });
  await page.waitForTimeout(550);
  await row.dispatchEvent('pointerup', { pointerType: 'touch', button: 0, buttons: 0 });
}

/** The host Bottom Actions slot and the contributed Files action row. */
async function bottomActionsState(page) {
  return page.evaluate(() => {
    const slot = document.querySelector('[data-testid="workspace-bottom-actions"]');
    const actions = document.querySelector('[data-testid="files-app-selection-bottom"]');
    const bar = document.querySelector('[data-testid="workspace-tool-bar"]');
    const list = document.querySelector('[data-testid="files-app-list"]');
    if (!(slot instanceof HTMLElement)) return null;
    const slotRect = slot.getBoundingClientRect();
    const actionRect = actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
    const listRect = list instanceof HTMLElement ? list.getBoundingClientRect() : null;
    return {
      slot: {
        display: getComputedStyle(slot).display,
        top: slotRect.top,
        bottom: slotRect.bottom,
        paddingBottom: getComputedStyle(slot).paddingBottom,
        children: slot.children.length,
      },
      actions: actionRect === null ? null : { top: actionRect.top, bottom: actionRect.bottom },
      list: listRect === null ? null : { top: listRect.top, bottom: listRect.bottom },
      capsuleTop: bar instanceof HTMLElement ? bar.getBoundingClientRect().top : null,
      ownedByHost: actions instanceof HTMLElement
        ? actions.closest('[data-testid="workspace-bottom-actions"]') === slot
        : false,
      insideCapabilityRoot: actions instanceof HTMLElement
        ? actions.closest('[data-testid="files-app-layout"]') !== null
        : false,
    };
  });
}

async function markTerminal(page) {
  await page.locator('.xterm').first().waitFor({ timeout: 30_000 });
  await page.locator('.xterm').first().evaluate((element) => {
    element.setAttribute('data-4115-terminal', 'original');
  });
}

function terminalMarkedCount(page) {
  return page.locator('.xterm[data-4115-terminal="original"]').count();
}

module.exports = {
  appViewports,
  landscapeViewport,
  openApp,
  seedLongFiles,
  seedLongEditableFile,
  openWorkspace,
  openFilesLong,
  growSandboxUntilScrolls,
  capsuleTop,
  scrollToEndAndMeasure,
  expectEndpoint,
  expectHostInset,
  longPress,
  bottomActionsState,
  markTerminal,
  terminalMarkedCount,
  MAX_BLANK_TAIL_PX,
  ROUNDING_TOLERANCE_PX,
};
