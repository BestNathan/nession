'use strict';
// Shared browser helpers for the #2750 focus-treatment Cases.
//
// The assertions read the focus tokens from the element itself, so the Case
// pins the shipped recipe (inset width/offset in `ring`) instead of a number
// copied into the test. The registry/helper owner for regression is
// `e2e/helpers/ui-assert/assertions.ts`; this module is deliberately the
// Acceptance-side observation, not a second product rule.

const { expect } = require('@playwright/test');

/** Open a client-side fixture route and wait for the real shell composition. */
async function openWebFixture(page, route = '/#/fixture') {
  await page.goto('about:blank');
  await page.goto(route);
  await page.locator('[data-testid="shell"]').first().waitFor({ state: 'visible', timeout: 25_000 });
}

/** True when a computed box-shadow paints anything (Tailwind keeps transparent placeholders). */
function visibleShadow(boxShadow) {
  if (boxShadow === 'none' || String(boxShadow).trim() === '') return false;
  const colors = String(boxShadow).match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-fA-F]{3,8}/g);
  if (colors === null) return true;
  return colors.some((color) => {
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 4) return hex[3] !== '0';
      if (hex.length === 8) return hex.slice(6) !== '00';
      return true;
    }
    const slash = color.match(/\/\s*([0-9.]+%?)\s*\)$/);
    if (slash !== null) {
      return Number.parseFloat(slash[1]) * (slash[1].endsWith('%') ? 0.01 : 1) > 0;
    }
    const fn = color.slice(0, color.indexOf('('));
    if (fn === 'rgba' || fn === 'hsla') {
      const parts = color.slice(color.indexOf('(') + 1, -1).split(',');
      const alpha = parts.at(-1)?.trim() ?? '1';
      return Number.parseFloat(alpha) * (alpha.endsWith('%') ? 0.01 : 1) > 0;
    }
    return true;
  });
}

/** Read focus-relevant computed style plus the resolved Nession colours. */
async function readFocusStyle(locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    const resolved = (property) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(' + property + ')';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    return {
      focused: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      border: s.borderTopColor,
      outlineStyle: s.outlineStyle,
      outlineWidth: Number.parseFloat(s.outlineWidth),
      outlineOffset: Number.parseFloat(s.outlineOffset),
      outlineColor: s.outlineColor,
      widthToken: s.getPropertyValue('--nession-focus-ring-width').trim(),
      offsetToken: s.getPropertyValue('--nession-focus-ring-offset').trim(),
      ring: resolved('--nession-ring'),
      destructive: resolved('--nession-destructive'),
      accent: resolved('--nession-accent'),
      background: s.backgroundColor,
      boxShadow: s.boxShadow,
    };
  });
}

/** Wait for a CSS transition to settle instead of sampling the first frame. */
async function waitForFocusStyle(locator, done, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let value = await readFocusStyle(locator);
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await readFocusStyle(locator);
  }
  return value;
}

/** Pointer focus added no outline/chrome; it may have repainted the border. */
function quietFocus(m) {
  return (m.outlineStyle === 'none' || m.outlineWidth <= 0) && !visibleShadow(m.boxShadow);
}

/** Keyboard focus is the token inset outline in ring, with no outer ring. */
function insetFocus(m) {
  const width = Number.parseFloat(m.widthToken);
  const offset = -Number.parseFloat(m.offsetToken);
  return Number.isFinite(width) &&
    Number.isFinite(offset) &&
    m.focusVisible &&
    m.outlineStyle === 'solid' &&
    Math.abs(m.outlineWidth - width) <= 0.5 &&
    Math.abs(m.outlineOffset - offset) <= 0.5 &&
    m.outlineOffset <= 0 &&
    m.outlineColor === m.ring &&
    !visibleShadow(m.boxShadow);
}

/** Assert the settled state of a focused control. */
async function expectFocus(locator, kind) {
  // `quiet-ring` additionally waits for the field's border repaint to settle;
  // `quiet` deliberately does not care what colour the border is.
  const done = kind === 'inset'
    ? insetFocus
    : kind === 'quiet-ring'
      ? (m) => quietFocus(m) && m.border === m.ring
      : quietFocus;
  const m = await waitForFocusStyle(locator, done);
  expect(done(m), JSON.stringify(m)).toBe(true);
  return m;
}

/** Press Tab from the current position until the named element owns focus. */
async function focusByTab(page, locator, maxTabs = 80) {
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((el) => document.activeElement === el)) return;
  }
  throw new Error('Tab traversal never reached the target control');
}

module.exports = {
  openWebFixture,
  visibleShadow,
  readFocusStyle,
  waitForFocusStyle,
  quietFocus,
  insetFocus,
  expectFocus,
  focusByTab,
};
