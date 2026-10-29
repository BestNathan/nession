'use strict';
// #2621 SC-03: the compact overlay stays root-owned and OUTSIDE the capsule
// host, floats above the bottom Capsule (never behind it, the #1307 defect),
// passes pointer events through everywhere it is not drawing a notice, does
// not steal focus, and fits 390px and desktop without horizontal overflow.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const { ALL_FOUR, openAppNotices, openWebNotices } = require('../../../shared/terminal-notice-cases.cjs');

const NOTICE_IDS = [
  'terminal-history-degraded',
  'terminal-input-drop',
  'terminal-clipboard-notice',
  'terminal-observer-bar',
];

async function readLayout(page) {
  return page.evaluate((noticeIds) => {
    const surface = document.querySelector('[data-testid="terminal-surface"]');
    const host = document.querySelector('[data-terminal-capsule-host]');
    const overlay = document.querySelector('[data-testid="terminal-status-overlay"]');
    const capsule = document.querySelector('[data-testid="terminal-capsule"]');
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        width: box.width, height: box.height,
      };
    };
    const centreHit = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { inside: element.contains(hit), tag: hit && hit.tagName };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      surface: rect(surface),
      host: rect(host),
      overlay: rect(overlay),
      capsule: rect(capsule),
      overlayInsideHost: !!(host && overlay && host.contains(overlay)),
      overlayRootOwned: !!(surface && overlay && overlay.parentElement === surface),
      overlayPosition: overlay ? getComputedStyle(overlay).position : null,
      overlayPointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : null,
      notices: noticeIds.map((id) => {
        const element = document.querySelector('[data-testid="' + id + '"]');
        return {
          id,
          present: element !== null,
          rect: rect(element),
          pointerEvents: element ? getComputedStyle(element).pointerEvents : null,
          hit: centreHit(element),
        };
      }),
    };
  }, NOTICE_IDS);
}

function expectOverlayContract(layout, label) {
  expect(layout.overlay, label + ': the overlay must exist').not.toBeNull();
  expect(layout.overlayRootOwned, label + ': the overlay is owned by the surface root').toBe(true);
  expect(layout.overlayInsideHost, label + ': the overlay must stay outside the capsule host').toBe(false);
  expect(layout.overlayPosition, label + ': the overlay is absolutely positioned').toBe('absolute');
  expect(layout.overlayPointerEvents, label + ': the overlay itself passes pointers through').toBe('none');
  for (const notice of layout.notices) {
    expect(notice.present, label + ': ' + notice.id + ' is present').toBe(true);
    expect(notice.pointerEvents, label + ': ' + notice.id + ' accepts its own pointers').toBe('auto');
    expect(notice.hit.inside, label + ': ' + notice.id + ' is the painted top layer').toBe(true);
    expect(notice.rect.left, label + ': ' + notice.id + ' starts inside the viewport').toBeGreaterThanOrEqual(0);
    expect(notice.rect.right, label + ': ' + notice.id + ' ends inside the viewport')
      .toBeLessThanOrEqual(layout.viewport.width);
    expect(notice.rect.bottom, label + ': ' + notice.id + ' never enters the capsule band')
      .toBeLessThanOrEqual(layout.capsule.top);
  }
  expect(layout.scrollWidth, label + ': no horizontal overflow').toBeLessThanOrEqual(layout.viewport.width);
}

test('SC-03: the overlay floats outside the capsule host and fits both widths', async ({ page }) => {
  test.setTimeout(300_000);
  const { sha } = verifiedRuntime('SC-03');

  // Narrow App: the canonical 390x844 with every status type at once.
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppNotices(page, ALL_FOUR);
  expectOverlayContract(await readLayout(page), 'App 390x844');

  // Desktop App: the same contract when there is plenty of room.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppNotices(page, ALL_FOUR);
  expectOverlayContract(await readLayout(page), 'App 1280x800');

  // Desktop Web with a real controller: pointer/focus behaviour.
  await openWebNotices(page, ALL_FOUR);
  const layout = await readLayout(page);
  expectOverlayContract(layout, 'Web 1280x800');

  // A point in the terminal, away from the top overlay, belongs to the terminal.
  const passthrough = await page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    const box = host.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.bottom - 30;
    const hit = document.elementFromPoint(x, y);
    return { inside: host.contains(hit), tag: hit && hit.tagName };
  });
  expect(passthrough.inside, 'the overlay intercepts no terminal pointer').toBe(true);

  // The terminal keeps focus and input while a notice disappears on its own.
  await page.locator('.xterm-helper-textarea').focus();
  expect(await page.evaluate(() => document.activeElement === document.querySelector('.xterm-helper-textarea')))
    .toBe(true);
  await page.evaluate(() => { window.clipboardHarness.sent.length = 0; });
  await page.keyboard.type('focus-survived');
  await expect.poll(() => page.evaluate(() => window.clipboardHarness.sent.join('')))
    .toContain('focus-survived');
  // The clipboard notice is the one status that expires on its own; the other
  // three inputs in ALL_FOUR stay. Its disappearance must not move focus.
  await expect(page.getByTestId('terminal-clipboard-notice')).toHaveCount(0, { timeout: 15_000 });
  expect(await page.evaluate(() => document.activeElement === document.querySelector('.xterm-helper-textarea')),
    'notice dismissal must not move focus').toBe(true);

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': App 390x844 and 1280x800 and Web 1280x800 each kept the ' +
      'overlay root-owned, absolute, pointer-events-none and outside the capsule host; all four ' +
      'notices were painted top layer, content-width and above the bottom Capsule; the terminal ' +
      'kept focus, accepted pointer hit-testing and received typed input across a notice expiry; ' +
      'no horizontal overflow',
  });
});
