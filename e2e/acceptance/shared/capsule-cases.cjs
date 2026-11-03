'use strict';
// Shared browser machinery for the #2663 Capsule Cases.
//
// Both canonical fixtures mount the production TerminalSurface + TerminalCapsule
// with deterministic data:
//   /#/fixture        Web experience
//   /#/fixture/app    App experience at 390x844
// `?pane=claude.exe` names the observation the agent reports for the pane; the
// product decides what it means.
const ROUTES = {
  web: '/fixture',
  app: '/fixture/app',
};

async function openCapsuleFixture(page, experience, params = '') {
  await page.goto('about:blank');
  await page.goto('/#' + ROUTES[experience] + params);
  await page.getByTestId('capsule-shell').waitFor();
  await page.getByTestId('capsule-capability-more').waitFor();
}

/** The rendered trigger, in a shape two routes can be compared by. */
async function readTrigger(page) {
  return page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="capsule-capability-more"]');
    if (!(trigger instanceof HTMLElement)) throw new Error('capsule trigger missing');
    const rect = trigger.getBoundingClientRect();
    const icon = trigger.querySelector('svg');
    const iconRect = icon?.getBoundingClientRect();
    const animations = [trigger, ...Array.from(trigger.querySelectorAll('*'))].map(
      (node) => getComputedStyle(node).animationName,
    );
    return {
      html: trigger.innerHTML,
      box: [Math.round(rect.width), Math.round(rect.height)],
      icon: iconRect ? [Math.round(iconRect.width), Math.round(iconRect.height)] : null,
      svgCount: trigger.querySelectorAll('svg').length,
      ringCount: document.querySelectorAll('[data-testid="work-ring"]').length,
      animations,
      // `aria-expanded` is interaction state, asserted by the interaction
      // Case; the visual identity compared here must not depend on it.
      ariaLabel: trigger.getAttribute('aria-label'),
    };
  });
}

/** Open the Context Capsule through the trigger and wait for it to settle. */
async function openDisclosure(page) {
  await page.getByTestId('capsule-capability-more').click();
  const surface = page.getByTestId('capsule-context-disclosure');
  await surface.waitFor();
  return surface;
}

/** Every capability row the disclosure currently offers. */
async function disclosureRows(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('[data-testid^="capsule-capability-picker-"]'),
  ).map((node) => ({
    testId: node.getAttribute('data-testid'),
    state: node.getAttribute('data-capability-state'),
    text: (node.textContent || '').trim(),
  })));
}

module.exports = {
  ROUTES,
  disclosureRows,
  openCapsuleFixture,
  openDisclosure,
  readTrigger,
};
